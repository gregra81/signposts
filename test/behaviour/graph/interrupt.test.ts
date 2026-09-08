// The long-lived interrupt, and the durability that makes it work.
//
// This is the property that makes the checkpointer non-optional. A person may
// answer three days later, in a different process — so the test resumes
// through a SECOND graph built on fresh ports, holding nothing from the first
// run except the three values that are on disk anyway (repo, session id,
// content hash). The thread id is recomputed from those, never remembered.

import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildExtractionGraph,
  resumeRun,
  startRun,
  threadConfigFor,
} from "../../../src/graph/index.js";
import { buildThreadId } from "../../../src/core/graph/thread-id.js";
import type { RunResult } from "../../../src/graph/index.js";
import { operationKey } from "../../../src/core/graph/decisions.js";
import {
  CHECKPOINT_FILENAME,
  STATE_VERSION,
  THREAD_EXPIRY_DAYS,
} from "../../../src/core/config/constants.js";
import {
  candidate,
  existingSignpost,
  gutteredSession,
  makeHarness,
  RUN_INPUT,
  type HarnessOptions,
} from "../helpers/graph-harness.js";

// The real SQLite checkpointer, not MemorySaver: an interrupt that only
// survives inside one process is not the thing 04-extraction-graph.md
// describes.
let stateDir: string;
let checkpointPath: string;
// Every saver a test opens, closed in afterEach. Each one is a live
// better-sqlite3 connection, and this file builds two or three per test — left
// open they accumulate for the whole file, which Stryker then re-runs once per
// mutant batch.
let savers: SqliteSaver[];

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "signposts-graph-"));
  checkpointPath = path.join(stateDir, CHECKPOINT_FILENAME);
  savers = [];
});

afterEach(() => {
  for (const saver of savers) {
    saver.db.close();
  }
  rmSync(stateDir, { recursive: true, force: true });
});

/** Opens a checkpointer on the test's database and registers it for cleanup. */
function openSaver(): SqliteSaver {
  const saver = SqliteSaver.fromConnString(checkpointPath);
  savers.push(saver);
  return saver;
}

const EXISTING = existingSignpost();

/** A run that will stop for a human: a retire always needs one. */
function gatedOptions(): HarnessOptions {
  return {
    session: gutteredSession(),
    existing: [EXISTING],
    neighbours: { t1: [EXISTING] },
    script: {
      extract: [{ candidates: [candidate({ confidence: 1 })] }],
      critic: [{ verdicts: [{ tempId: "t1", keep: true, reason: "durable" }] }],
      classify: [
        { tempId: "t1", kind: "CONTRADICTION", relatedId: EXISTING.id, rationale: "opposite" },
      ],
      resolve: [{ tempId: "t1", outcome: "new_wins", reasoning: "the config changed in March" }],
    },
  };
}

/** A separate process would build all of this from scratch. So does this. */
function freshProcess(options: HarnessOptions) {
  const ports = makeHarness(options);
  const checkpointer = openSaver();
  return { ports, checkpointer, graph: buildExtractionGraph({ ports, checkpointer }) };
}

/**
 * The id the halted thread is waiting under. Every answer is filed by it —
 * a review decision travels the same way a model answer does, because to the
 * graph they are the same thing.
 */
function haltId(result: RunResult): string {
  const [pending] = result.pending;
  if (pending === undefined) {
    throw new Error("the run did not halt");
  }
  return pending.id;
}

describe("the long-lived interrupt", () => {
  it("halts without committing when the gate needs a human", async () => {
    const first = freshProcess(gatedOptions());

    const result = await startRun(first.graph, first.checkpointer, RUN_INPUT);

    expect(result.state.gated.needsHuman).toHaveLength(1);
    expect(first.ports.commit.applied).toEqual([]);
  });

  it("resumes in a different process and commits the accepted operation", async () => {
    const first = freshProcess(gatedOptions());
    const halted = await startRun(first.graph, first.checkpointer, RUN_INPUT);
    const [pending] = halted.state.gated.needsHuman;
    expect(pending).toBeDefined();

    // Three days pass. Nothing from `first` survives except the checkpoint file.
    const second = freshProcess(gatedOptions());
    await resumeRun(
      second.graph,
      second.checkpointer,
      { repo: RUN_INPUT.repo, sessionId: RUN_INPUT.sessionId, contentHash: RUN_INPUT.contentHash },
      { [haltId(halted)]: { [operationKey(pending!.operation)]: { decision: "accept", decidedAt: "2026-08-30" } } },
    );

    expect(second.ports.commit.applied).toHaveLength(1);
    expect(second.ports.commit.operations).toEqual([pending!.operation]);
  });

  it("does not re-run extraction on resume", async () => {
    const first = freshProcess(gatedOptions());
    const halted = await startRun(first.graph, first.checkpointer, RUN_INPUT);
    const [pending] = halted.state.gated.needsHuman;

    const second = freshProcess(gatedOptions());
    await resumeRun(
      second.graph,
      second.checkpointer,
      { repo: RUN_INPUT.repo, sessionId: RUN_INPUT.sessionId, contentHash: RUN_INPUT.contentHash },
      { [haltId(halted)]: { [operationKey(pending!.operation)]: { decision: "accept", decidedAt: "2026-08-30" } } },
    );

    expect(second.ports.model.callsTo("extract")).toEqual([]);
    expect(second.ports.model.calls).toEqual([]);
  });

  it("commits nothing when the human rejects", async () => {
    const first = freshProcess(gatedOptions());
    const halted = await startRun(first.graph, first.checkpointer, RUN_INPUT);
    const [pending] = halted.state.gated.needsHuman;

    const second = freshProcess(gatedOptions());
    await resumeRun(
      second.graph,
      second.checkpointer,
      { repo: RUN_INPUT.repo, sessionId: RUN_INPUT.sessionId, contentHash: RUN_INPUT.contentHash },
      { [haltId(halted)]: { [operationKey(pending!.operation)]: { decision: "reject", decidedAt: "2026-08-30" } } },
    );

    expect(second.ports.commit.operations).toEqual([]);
  });

  it("commits the human's replacement when they edit", async () => {
    const first = freshProcess(gatedOptions());
    const halted = await startRun(first.graph, first.checkpointer, RUN_INPUT);
    const [pending] = halted.state.gated.needsHuman;
    // Reworded by hand, still superseding the same signpost: an edit changes
    // what the operation says, not what it acts on (06-review-and-pr.md).
    const edited = {
      ...pending!.operation,
      replacement: { ...EXISTING, claim: "Staging is read only, rephrased by hand" },
    };

    const second = freshProcess(gatedOptions());
    await resumeRun(
      second.graph,
      second.checkpointer,
      { repo: RUN_INPUT.repo, sessionId: RUN_INPUT.sessionId, contentHash: RUN_INPUT.contentHash },
      { [haltId(halted)]: { [operationKey(pending!.operation)]: { decision: "edit", edited, decidedAt: "2026-08-30" } } },
    );

    expect(second.ports.commit.operations).toEqual([edited]);
  });
});

describe("a review answered in instalments", () => {
  const OTHER = existingSignpost({ id: "etl-window", claim: "The ETL window is 01:00-02:00" });

  /** Two contradictions, so the gate holds two operations for a person. */
  function twoGatedOptions(): HarnessOptions {
    return {
      session: gutteredSession(),
      existing: [EXISTING, OTHER],
      neighbours: { t1: [EXISTING], t2: [OTHER] },
      script: {
        extract: [
          {
            candidates: [
              candidate({ tempId: "t1", confidence: 1 }),
              candidate({ tempId: "t2", claim: "The ETL window is 03:00-04:00", confidence: 1 }),
            ],
          },
        ],
        critic: [
          {
            verdicts: [
              { tempId: "t1", keep: true, reason: "durable" },
              { tempId: "t2", keep: true, reason: "durable" },
            ],
          },
        ],
        classify: [
          { tempId: "t1", kind: "CONTRADICTION", relatedId: EXISTING.id, rationale: "opposite" },
          { tempId: "t2", kind: "CONTRADICTION", relatedId: OTHER.id, rationale: "opposite" },
        ],
        resolve: [
          { tempId: "t1", outcome: "new_wins", reasoning: "the config changed in March" },
          { tempId: "t2", outcome: "new_wins", reasoning: "the schedule moved" },
        ],
      },
    };
  }

  const parts = {
    repo: RUN_INPUT.repo,
    sessionId: RUN_INPUT.sessionId,
    contentHash: RUN_INPUT.contentHash,
  };

  async function haltWithTwo() {
    const first = freshProcess(twoGatedOptions());
    const halted = await startRun(first.graph, first.checkpointer, RUN_INPUT);
    expect(halted.state.gated.needsHuman).toHaveLength(2);
    return {
      operations: halted.state.gated.needsHuman.map(({ operation }) => operation),
      id: haltId(halted),
    };
  }

  // The partial-review bug: answering one of two used to write that decision,
  // fall through to `commit`, and end the thread with the other discarded.
  it("commits nothing and stays halted when only one of two is answered", async () => {
    const { operations: [one], id } = await haltWithTwo();

    const second = freshProcess(twoGatedOptions());
    const result = await resumeRun(second.graph, second.checkpointer, parts, {
      [id]: {
        [operationKey(one!)]: { decision: "accept", decidedAt: "2026-08-30" },
      },
    });

    expect(second.ports.commit.applied).toEqual([]);
    expect(result.state.humanDecisions).toEqual({});
  });

  it("keeps the first answer and commits both once the second arrives", async () => {
    const { operations: [one, two], id } = await haltWithTwo();

    const second = freshProcess(twoGatedOptions());
    await resumeRun(second.graph, second.checkpointer, parts, {
      [id]: {
        [operationKey(one!)]: { decision: "accept", decidedAt: "2026-08-30" },
      },
    });

    // A third process, another day. The first answer is not re-sent.
    const third = freshProcess(twoGatedOptions());
    await resumeRun(third.graph, third.checkpointer, parts, {
      [id]: {
        [operationKey(two!)]: { decision: "accept", decidedAt: "2026-08-31" },
      },
    });

    expect(third.ports.commit.operations).toHaveLength(2);
  });

  it("asks only about what is still outstanding on the second halt", async () => {
    const { operations: [one, two], id } = await haltWithTwo();

    const second = freshProcess(twoGatedOptions());
    await resumeRun(second.graph, second.checkpointer, parts, {
      [id]: {
        [operationKey(one!)]: { decision: "accept", decidedAt: "2026-08-30" },
      },
    });

    const snapshot = await second.graph.getState(threadConfigFor(buildThreadId(RUN_INPUT)));
    const [pending] = snapshot.tasks.flatMap((task) => task.interrupts);
    expect(pending?.value).toMatchObject({ needsHuman: [{ operation: two }] });
  });

  // 06-review-and-pr.md's prompt names the signpost in its header and offers
  // [e]dit on the replacement text. Retargeting is not an edit, and it would
  // reach `commit` without passing `validate`, which ran before the gate.
  it("rejects an edit that points at a different signpost", async () => {
    const { operations: [one], id } = await haltWithTwo();

    const second = freshProcess(twoGatedOptions());
    await expect(
      resumeRun(second.graph, second.checkpointer, parts, {
        [id]: {
          [operationKey(one!)]: {
            decision: "edit",
            edited: { op: "supersede", id: "no-such-signpost", replacement: EXISTING },
            decidedAt: "2026-08-30",
          },
        },
      }),
    ).rejects.toThrow(
      "human_review: an edit may change an operation but not what it targets; " +
        `retargeted: ${operationKey(one!)}`,
    );

    expect(second.ports.commit.applied).toEqual([]);
  });

  it("names every retargeted edit, not just the first", async () => {
    const { operations: [one, two], id } = await haltWithTwo();
    const elsewhere = (id: string) =>
      ({ op: "supersede", id, replacement: EXISTING }) as const;

    const second = freshProcess(twoGatedOptions());
    await expect(
      resumeRun(second.graph, second.checkpointer, parts, {
        [id]: {
          [operationKey(one!)]: {
            decision: "edit",
            edited: elsewhere("no-such-signpost"),
            decidedAt: "2026-08-30",
          },
          [operationKey(two!)]: {
            decision: "edit",
            edited: elsewhere("nor-this-one"),
            decidedAt: "2026-08-30",
          },
        },
      }),
    ).rejects.toThrow(
      "human_review: an edit may change an operation but not what it targets; " +
        `retargeted: ${operationKey(one!)}, ${operationKey(two!)}`,
    );
  });

  it("accepts an edit that only reworks the operation it replaces", async () => {
    const { operations: [one, two], id } = await haltWithTwo();
    const reworded = { ...one!, replacement: { ...EXISTING, claim: "Reworded by hand" } };

    const second = freshProcess(twoGatedOptions());
    await resumeRun(second.graph, second.checkpointer, parts, {
      [id]: {
        [operationKey(one!)]: { decision: "edit", edited: reworded, decidedAt: "2026-08-30" },
        [operationKey(two!)]: { decision: "reject", decidedAt: "2026-08-30" },
      },
    });

    expect(second.ports.commit.operations).toEqual([reworded]);
  });

  it("refuses an answer keyed by anything but the halt's own id", async () => {
    // The map form of `resume` is only recognised when every key is an
    // interrupt id; one that is not silently demotes the whole object to the
    // bare form, which hands all of it to every halted task.
    const { operations: [one] } = await haltWithTwo();

    const second = freshProcess(twoGatedOptions());
    await expect(
      resumeRun(second.graph, second.checkpointer, parts, {
        [operationKey(one!)]: { decision: "accept", decidedAt: "2026-08-30" },
      }),
    ).rejects.toThrow(/is not waiting on supersede:/);

    expect(second.ports.commit.applied).toEqual([]);
  });

  it("rejects a resume payload that is not a valid set of decisions", async () => {
    const { operations: [one], id } = await haltWithTwo();

    const second = freshProcess(twoGatedOptions());
    await expect(
      resumeRun(second.graph, second.checkpointer, parts, {
        // "edit" with no replacement: applyDecisions would have committed the
        // original operation, which is the opposite of what was asked.
        [id]: { [operationKey(one!)]: { decision: "edit", decidedAt: "2026-08-30" } },
      }),
    ).rejects.toThrow(/not a valid set of decisions/);

    expect(second.ports.commit.applied).toEqual([]);
  });
});

describe("thread identity", () => {
  it("re-running an unchanged session lands on the same thread and re-extracts nothing", async () => {
    const first = freshProcess({
      session: gutteredSession(),
      script: {
        extract: [{ candidates: [candidate()] }],
        critic: [{ verdicts: [{ tempId: "t1", keep: true, reason: "r" }] }],
        classify: [{ tempId: "t1", kind: "NOVEL", rationale: "r" }],
      },
    });
    const done = await startRun(first.graph, first.checkpointer, RUN_INPUT);
    expect(done.disposition).toBe("fresh");

    const second = freshProcess({
      session: gutteredSession(),
      script: {
        extract: [{ candidates: [candidate()] }],
        critic: [{ verdicts: [{ tempId: "t1", keep: true, reason: "r" }] }],
        classify: [{ tempId: "t1", kind: "NOVEL", rationale: "r" }],
      },
    });
    const again = await startRun(second.graph, second.checkpointer, RUN_INPUT);

    expect(again.disposition).toBe("resumed");
    expect(second.ports.model.calls).toEqual([]);
    expect(second.ports.commit.applied).toEqual([]);
  });

  // contentHash is part of the thread id, so an edited transcript is a
  // different thread — a resume can never gutter different bytes than the run
  // that was interrupted.
  it("treats a transcript that changed since the interrupt as a different thread", async () => {
    const first = freshProcess(gatedOptions());
    await startRun(first.graph, first.checkpointer, RUN_INPUT);

    const second = freshProcess({
      ...gatedOptions(),
      session: gutteredSession({ contentHash: "hash-2" }),
    });
    const changed = await startRun(second.graph, second.checkpointer, {
      ...RUN_INPUT,
      contentHash: "hash-2",
    });

    expect(changed.threadId).not.toBe(buildThreadId(RUN_INPUT));
    expect(changed.disposition).toBe("fresh");
    expect(second.ports.model.callsTo("extract")).toHaveLength(1);
  });
});

// 15-spec.md pairs this with the version rule: "A thread older than the
// expiry is dropped with a log line." A review nobody answered for a month was
// partitioned against a repo that has moved on.
describe("a thread past the expiry", () => {
  /** Backdates the thread's checkpoint by `days`, as a month of silence would. */
  async function backdate(days: number): Promise<void> {
    const saver = openSaver();
    const config = { configurable: { thread_id: buildThreadId(RUN_INPUT) } };
    const tuple = await saver.getTuple(config);
    expect(tuple).toBeDefined();
    await saver.put(
      tuple!.config,
      {
        ...tuple!.checkpoint,
        ts: new Date(Date.now() - days * 86_400_000).toISOString(),
      },
      tuple!.metadata ?? { source: "update", step: -1, parents: {} },
    );
  }

  it("drops the checkpoint, logs why, and extracts again", async () => {
    const stale = freshProcess(gatedOptions());
    await startRun(stale.graph, stale.checkpointer, RUN_INPUT);
    await backdate(THREAD_EXPIRY_DAYS + 1);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const next = freshProcess(gatedOptions());
    const result = await startRun(next.graph, next.checkpointer, RUN_INPUT);

    expect(result.disposition).toBe("discarded");
    expect(next.ports.model.callsTo("extract")).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      `Checkpointed review for thread ${buildThreadId(RUN_INPUT)} is ` +
        `${String(THREAD_EXPIRY_DAYS + 1)} days old (expiry ${String(THREAD_EXPIRY_DAYS)} days). ` +
        "Dropping it and extracting again.",
    );
    warn.mockRestore();
  });

  it("refuses to answer a review on an expired thread", async () => {
    const stale = freshProcess(gatedOptions());
    const halted = await startRun(stale.graph, stale.checkpointer, RUN_INPUT);
    const [pending] = halted.state.gated.needsHuman;
    await backdate(THREAD_EXPIRY_DAYS + 1);

    const next = freshProcess(gatedOptions());
    await expect(
      resumeRun(
        next.graph,
        next.checkpointer,
        { repo: RUN_INPUT.repo, sessionId: RUN_INPUT.sessionId, contentHash: RUN_INPUT.contentHash },
        { [operationKey(pending!.operation)]: { decision: "accept", decidedAt: "2026-08-30" } },
      ),
    ).rejects.toThrow(
      `resumeRun: thread ${buildThreadId(RUN_INPUT)} expired ` +
        `(${String(THREAD_EXPIRY_DAYS + 1)} days old, expiry ${String(THREAD_EXPIRY_DAYS)} days). ` +
        "Re-run the extraction and review it again.",
    );

    expect(next.ports.commit.applied).toEqual([]);
  });

  it("still resumes a thread inside the expiry", async () => {
    const stale = freshProcess(gatedOptions());
    await startRun(stale.graph, stale.checkpointer, RUN_INPUT);
    await backdate(THREAD_EXPIRY_DAYS - 1);

    const next = freshProcess(gatedOptions());
    const result = await startRun(next.graph, next.checkpointer, RUN_INPUT);

    expect(result.disposition).toBe("resumed");
    expect(next.ports.model.callsTo("extract")).toHaveLength(0);
  });
});

describe("an unrecognised state version", () => {
  // The rule: discard and re-run from the transcript. Never resume into a
  // shape this build no longer understands.
  it("discards the checkpoint and starts the run again", async () => {
    const stale = freshProcess(gatedOptions());
    await startRun(stale.graph, stale.checkpointer, RUN_INPUT);

    // Rewrite the checkpointed version to something this build does not know,
    // exactly as a build from a later state shape would have left it.
    const threadId = buildThreadId(RUN_INPUT);
    const saver = openSaver();
    const config = { configurable: { thread_id: threadId } };
    const tuple = await saver.getTuple(config);
    expect(tuple).toBeDefined();
    await saver.put(
      tuple!.config,
      {
        ...tuple!.checkpoint,
        channel_values: { ...tuple!.checkpoint.channel_values, version: STATE_VERSION + 1 },
      },
      tuple!.metadata ?? { source: "update", step: -1, parents: {} },
    );

    const next = freshProcess(gatedOptions());
    const result = await startRun(next.graph, next.checkpointer, RUN_INPUT);

    expect(result.disposition).toBe("discarded");
    // Re-run from the transcript: the transcript was read again and the model
    // was asked again, rather than the halted state being resumed.
    expect(next.ports.gutter.calls).toBeGreaterThan(0);
    expect(next.ports.model.callsTo("extract")).toHaveLength(1);
  });

  // The path the version check exists for: a resume days later, from another
  // process, after an upgrade. `startRun` guarded it; this did not.
  it("refuses to answer a review on a thread it cannot resume", async () => {
    const stale = freshProcess(gatedOptions());
    const halted = await startRun(stale.graph, stale.checkpointer, RUN_INPUT);
    const [pending] = halted.state.gated.needsHuman;

    const threadId = buildThreadId(RUN_INPUT);
    const saver = openSaver();
    const config = { configurable: { thread_id: threadId } };
    const tuple = await saver.getTuple(config);
    await saver.put(
      tuple!.config,
      {
        ...tuple!.checkpoint,
        channel_values: { ...tuple!.checkpoint.channel_values, version: STATE_VERSION + 1 },
      },
      tuple!.metadata ?? { source: "update", step: -1, parents: {} },
    );

    const next = freshProcess(gatedOptions());
    await expect(
      resumeRun(
        next.graph,
        next.checkpointer,
        { repo: RUN_INPUT.repo, sessionId: RUN_INPUT.sessionId, contentHash: RUN_INPUT.contentHash },
        { [operationKey(pending!.operation)]: { decision: "accept", decidedAt: "2026-08-30" } },
      ),
    ).rejects.toThrow(
      `resumeRun: thread ${threadId} cannot be resumed by this build ` +
        `(state version ${String(STATE_VERSION)}, checkpoint ${String(STATE_VERSION + 1)}). ` +
        "Re-run the extraction and review it again.",
    );

    expect(next.ports.commit.applied).toEqual([]);
  });

  // Nothing checkpointed at all — a resume for a thread that was never
  // started, or whose checkpoint file has been cleared out from under it.
  it("refuses a resume when there is no checkpoint to answer", async () => {
    const only = freshProcess(gatedOptions());

    await expect(
      resumeRun(
        only.graph,
        only.checkpointer,
        { repo: RUN_INPUT.repo, sessionId: RUN_INPUT.sessionId, contentHash: RUN_INPUT.contentHash },
        {},
      ),
    ).rejects.toThrow(
      `resumeRun: thread ${buildThreadId(RUN_INPUT)} cannot be resumed by this build ` +
        `(state version ${String(STATE_VERSION)}, checkpoint absent). ` +
        "Re-run the extraction and review it again.",
    );

    expect(only.ports.commit.applied).toEqual([]);
  });

  it("resumes normally when the version is the one this build writes", async () => {
    const first = freshProcess(gatedOptions());
    await startRun(first.graph, first.checkpointer, RUN_INPUT);

    const second = freshProcess(gatedOptions());
    const result = await startRun(second.graph, second.checkpointer, RUN_INPUT);

    expect(result.disposition).toBe("resumed");
    expect(result.state.version).toBe(STATE_VERSION);
  });
});
