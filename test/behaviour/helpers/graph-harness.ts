// Hand-written fakes for the extraction graph's ports, plus a scripted
// ModelProvider. No mocking framework (16-build-plan.md), and no live calls:
// each node's replies are queued in order, so a test states exactly what the
// model says and the graph does the rest.
//
// The provider is scripted rather than FixtureModelProvider because these
// tests assert on *call counts and ordering* — how many times `extract` ran,
// whether `resolve_conflict` ran at all — which is what the loops and the
// fan-out actually are. A fixture keyed on the user turn would couple every
// test to the exact bytes of a prompt it is not testing.

import { MemorySaver } from "@langchain/langgraph";
import { STATE_VERSION } from "../../../src/core/config/constants.ts";
import { buildExtractionGraph } from "../../../src/graph/index.ts";
import type { JSONSchema, ModelProvider, NodeName } from "../../../src/core/model/types.ts";
import type { GutteredSession } from "../../../src/core/gutter/types.ts";
import type { Candidate, NeighbourSignpost, Operation } from "../../../src/core/contracts/graph.ts";
import type { PendingProposal } from "../../../src/core/graph/pending.ts";
import type { Signpost } from "../../../src/core/signpost/schema.ts";
import type { ExtractionState } from "../../../src/graph/state.ts";
import type {
  CommitInput,
  CommitPort,
  GraphPorts,
  GutterPort,
  NeighbourPort,
  PendingIndexPort,
  SignpostIndexPort,
} from "../../../src/graph/index.ts";

export interface RecordedCall {
  node: NodeName;
  system: string;
  user: string;
  schema: JSONSchema;
}

/**
 * Replies per node, consumed in order. The last reply repeats if exhausted.
 *
 * A reply may be a function of the call instead of a literal, for the tests
 * where what the model says has to depend on what the node showed it — a
 * classification that turns on whether any neighbour came back, say. A
 * literal reply cannot express that without deciding the outcome in advance.
 */
export type Script = Partial<Record<NodeName, unknown[]>>;

export class ScriptedModelProvider implements ModelProvider {
  readonly calls: RecordedCall[] = [];
  private readonly queues: Record<string, unknown[]>;

  constructor(script: Script) {
    this.queues = Object.fromEntries(
      Object.entries(script).map(([node, replies]) => [node, [...(replies ?? [])]]),
    );
  }

  callsTo(node: NodeName): RecordedCall[] {
    return this.calls.filter((call) => call.node === node);
  }

  async structured<T>(req: {
    node: NodeName;
    system: string;
    user: string;
    schema: JSONSchema;
  }): Promise<T> {
    const call: RecordedCall = {
      node: req.node,
      system: req.system,
      user: req.user,
      schema: req.schema,
    };
    this.calls.push(call);

    const queue = this.queues[req.node];
    if (queue === undefined || queue.length === 0) {
      throw new Error(`ScriptedModelProvider: nothing scripted for ${req.node}`);
    }

    // Fan-out tasks run concurrently and in no guaranteed order, so a reply
    // carrying a tempId is matched to the call whose user turn names that
    // tempId rather than to the next call in sequence. Without this a test
    // asserting "t1 contradicts" could hand that reply to t2's task.
    const addressed = queue.find(
      (reply) => hasTempId(reply) && req.user.includes(`"tempId":"${reply.tempId}"`),
    );
    if (addressed !== undefined) {
      return addressed as T;
    }

    // The last reply is reused rather than consumed, so a node called N times
    // needs one entry unless the test wants the answers to differ.
    const reply = queue.length === 1 ? queue[0] : queue.shift();
    const value = typeof reply === "function" ? (reply as (call: RecordedCall) => unknown)(call) : reply;
    return value as T;
  }
}

function hasTempId(reply: unknown): reply is { tempId: string } {
  return typeof reply === "object" && reply !== null && typeof (reply as { tempId?: unknown }).tempId === "string";
}

export class FakeGutterPort implements GutterPort {
  calls = 0;
  private readonly session: GutteredSession;

  constructor(session: GutteredSession) {
    this.session = session;
  }

  async gutter(_transcriptPath: string): Promise<GutteredSession> {
    this.calls += 1;
    // A fresh copy each time: guttering is deterministic, and returning the
    // same object would hide a node that mutated it.
    return structuredClone(this.session);
  }
}

/**
 * Records what each session proposed, and hands it back through the neighbour
 * and index ports — the in-memory stand-in for src/io/db/pending-index.ts,
 * which does the same three writes against SQLite.
 */
export class FakePendingIndexPort implements PendingIndexPort {
  readonly indexed: { repo: string; proposals: PendingProposal[] }[] = [];
  readonly cleared: string[] = [];

  async indexPending(repo: string, proposals: readonly PendingProposal[]): Promise<void> {
    this.indexed.push({ repo, proposals: [...proposals] });
  }

  async clear(repo: string): Promise<void> {
    this.cleared.push(repo);
    for (let i = this.indexed.length - 1; i >= 0; i -= 1) {
      if (this.indexed[i]?.repo === repo) {
        this.indexed.splice(i, 1);
      }
    }
  }

  /** Everything proposed for `repo` so far in this run, each with its state. */
  forRepo(repo: string): PendingProposal[] {
    return this.indexed.filter((entry) => entry.repo === repo).flatMap((entry) => entry.proposals);
  }
}

export class FakeNeighbourPort implements NeighbourPort {
  calls: string[] = [];
  private readonly byTempId: Record<string, Signpost[]>;
  private readonly pendingIndex: FakePendingIndexPort;

  constructor(byTempId: Record<string, Signpost[]> = {}, pendingIndex = new FakePendingIndexPort()) {
    this.byTempId = byTempId;
    this.pendingIndex = pendingIndex;
  }

  // Whatever the test scripted for this tempId, plus everything an earlier
  // session in the run proposed. Real retrieval ranks and truncates; this
  // returns the lot, because the tests using it are about whether a proposal
  // is visible at all, not about ranking.
  async find(repo: string, candidate: Candidate): Promise<NeighbourSignpost[]> {
    this.calls.push(candidate.tempId);
    const merged = this.pendingIndex
      .forRepo(repo)
      .map(({ signpost, state }) => ({ ...signpost, pending: state }));
    return [...(this.byTempId[candidate.tempId] ?? []), ...merged];
  }
}

export class FakeIndexPort implements SignpostIndexPort {
  /** Ids `byId` was asked for, so a test can assert the mirror was not consulted. */
  readonly byIdCalls: string[] = [];
  private readonly signposts: Signpost[];
  private readonly bootstrap: boolean;
  private readonly pendingIndex: FakePendingIndexPort;

  constructor(signposts: Signpost[] = [], bootstrap = false, pendingIndex = new FakePendingIndexPort()) {
    this.signposts = signposts;
    this.bootstrap = bootstrap;
    this.pendingIndex = pendingIndex;
  }

  // Pending rows count as existing, exactly as they do in SQLite: they are
  // rows in the same `signposts` table. Without this, `validate` would reject
  // a `reinforce` of a claim the previous session in this run proposed. What
  // stops that reinforce from auto-publishing against a signpost nobody has
  // merged is the gate, not this — see partition.ts's `pending_neighbour`.
  private all(repo: string): Signpost[] {
    return [...this.signposts, ...this.pendingIndex.forRepo(repo).map(({ signpost }) => signpost)];
  }

  async existingIds(repo: string): Promise<Set<string>> {
    return new Set(this.all(repo).map((signpost) => signpost.id));
  }

  async isBootstrap(): Promise<boolean> {
    return this.bootstrap;
  }

  async byId(repo: string, id: string): Promise<Signpost | undefined> {
    this.byIdCalls.push(id);
    return this.all(repo).find((signpost) => signpost.id === id);
  }
}

export class FakeCommitPort implements CommitPort {
  readonly applied: CommitInput[] = [];

  async apply(input: CommitInput): Promise<void> {
    this.applied.push(input);
  }

  get operations(): Operation[] {
    return this.applied.flatMap((input) => [...input.operations]);
  }
}

export interface HarnessOptions {
  script: Script;
  session: GutteredSession;
  neighbours?: Record<string, Signpost[]>;
  existing?: Signpost[];
  bootstrap?: boolean;
  now?: Date;
  /** The repo's CLAUDE.md, for the critic. Omitted = a repo that has none. */
  conventions?: string;
}

export interface Harness extends GraphPorts {
  model: ScriptedModelProvider;
  gutter: FakeGutterPort;
  neighbours: FakeNeighbourPort;
  pendingIndex: FakePendingIndexPort;
  index: FakeIndexPort;
  commit: FakeCommitPort;
}

export const AUTHOR = "dev@acme.example";

export function makeHarness(options: HarnessOptions): Harness {
  const now = options.now ?? new Date("2026-08-27T09:00:00.000Z");
  // One pending index, shared by the two ports that read it — the same object
  // the run loop writes to, so a proposal made by session N is visible to
  // session N+1 through retrieval and through the id check.
  const pendingIndex = new FakePendingIndexPort();
  return {
    model: new ScriptedModelProvider(options.script),
    gutter: new FakeGutterPort(options.session),
    neighbours: new FakeNeighbourPort(options.neighbours ?? {}, pendingIndex),
    pendingIndex,
    index: new FakeIndexPort(options.existing ?? [], options.bootstrap ?? false, pendingIndex),
    commit: new FakeCommitPort(),
    ...(options.conventions === undefined
      ? {}
      : { conventions: { read: async (): Promise<string | null> => options.conventions ?? null } }),
    author: AUTHOR,
    now: () => now,
  };
}

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

export function gutteredSession(overrides: Partial<GutteredSession> = {}): GutteredSession {
  return {
    sessionId: "sess-1",
    contentHash: "hash-1",
    repo: "acme/api",
    repoRoot: "/repo",
    startedAt: "2026-08-26T09:00:00.000Z",
    lastActivityAt: "2026-08-26T10:00:00.000Z",
    turns: [
      { role: "assistant", text: "I will write to staging.", at: "t1" },
      { role: "human", text: "No — staging is read only outside the ETL window.", at: "t2" },
    ],
    // Comfortably over MIN_GUTTERED_TOKENS so the early exit does not fire.
    tokenEstimate: 500,
    redactionCount: 0,
    ...overrides,
  };
}

export function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    tempId: "t1",
    claim: "Staging is read only outside the ETL window",
    category: "environment",
    scope: { repo: "acme/api" },
    evidence: "The human said so after a failed write.",
    confidence: 0.95,
    hedged: false,
    ...overrides,
  };
}

export function existingSignpost(overrides: Partial<Signpost> = {}): Signpost {
  return {
    id: "staging-writable",
    claim: "Staging is writable at any time",
    category: "environment",
    scope: { repo: "acme/api" },
    evidence: "From an earlier session.",
    confidence: 0.8,
    provenance: {
      session_ids: ["sess-0"],
      authors: [AUTHOR],
      first_seen: "2026-01-01",
      last_reinforced: "2026-01-01",
    },
    status: "active",
    ...overrides,
  };
}

export const RUN_INPUT = {
  repo: "acme/api",
  sessionId: "sess-1",
  contentHash: "hash-1",
  repoRoot: "/repo",
  transcriptPath: "/transcripts/sess-1.jsonl",
};

/**
 * A compiled graph plus the fakes behind it. MemorySaver only —
 * 04-extraction-graph.md permits it in tests and nowhere else; production
 * uses the SQLite checkpointer.
 */
export function makeGraph(options: HarnessOptions) {
  const ports = makeHarness(options);
  const checkpointer = new MemorySaver();
  return { ports, checkpointer, graph: buildExtractionGraph({ ports, checkpointer }) };
}

/**
 * A complete ExtractionState, for calling a node directly rather than through
 * the graph. The channel defaults are asserted in test/unit/graph/state.test.ts;
 * this is only a starting point for overriding the two or three fields a node
 * test is about.
 */
export function graphState(overrides: Partial<ExtractionState> = {}): ExtractionState {
  return {
    version: STATE_VERSION,
    sessionId: RUN_INPUT.sessionId,
    repo: RUN_INPUT.repo,
    repoRoot: RUN_INPUT.repoRoot,
    contentHash: RUN_INPUT.contentHash,
    transcriptPath: RUN_INPUT.transcriptPath,
    gutterStats: { tokenEstimate: 500, humanTurns: 1, redactionCount: 0 },
    candidates: [],
    critique: undefined,
    extractAttempts: 0,
    criticRetries: 0,
    neighbours: {},
    classifications: {},
    resolutions: {},
    validated: [],
    carriedValid: [],
    operations: [],
    gated: { auto: [], needsHuman: [] },
    validationErrors: [],
    validateAttempts: 0,
    humanDecisions: {},
    ...overrides,
  };
}
