// The edges the extraction graph talks to. Every one of these is IO the graph
// itself must not do: reading a transcript off disk, querying the signpost
// mirror, writing markdown and opening a pull request.
//
// They are declared here as interfaces, wired at the composition root, and
// substituted with fakes in tests — the same pattern as src/app.ts's `Ports`.
// Nothing in src/graph/ constructs one.

import type { GutteredSession } from "../core/gutter/types.ts";
import type { Candidate, NeighbourSignpost, Operation } from "../core/contracts/graph.ts";
import type { PendingProposal } from "../core/graph/pending.ts";
import type { ModelProvider } from "../core/model/types.ts";
import type { Signpost } from "../core/signpost/schema.ts";

/**
 * Reads and reduces one transcript (02-ingestion.md). Called twice per run —
 * once by `gutter` for its stats, once by `extract` for the text — and that
 * is safe precisely because it is deterministic: the same file yields the
 * same bytes, and `contentHash` is part of the thread id, so a file that
 * changed since an interrupt belongs to a different thread entirely.
 */
export interface GutterPort {
  gutter(transcriptPath: string): Promise<GutteredSession>;
}

/**
 * The repo's own conventions file (CLAUDE.md), for the `critic` to judge
 * candidates against — a claim the repo already writes down is not new
 * (19-value-to-a-user.md item on critic precision). Capped by the
 * implementation, so the graph hands whatever it gets straight to the prompt.
 *
 * `null` for a repo with no such file, which is most of them.
 */
export interface ConventionsPort {
  read(): Promise<string | null>;
}

/** Hybrid search over the signpost mirror (05-retrieval.md). */
export interface NeighbourPort {
  /**
   * Top-k active signposts for this candidate, in the repo. Never padded to k.
   *
   * Includes anything an earlier session in the same run proposed, flagged
   * `pending` — see PendingIndexPort.
   */
  find(repo: string, candidate: Candidate): Promise<NeighbourSignpost[]>;
}

/**
 * Incremental reindex of what one session proposed, run between sessions
 * (06-review-and-pr.md, "Reindex within a run, not only at commit").
 *
 * Without it, every session in a run retrieves against the index as it stood
 * when the run began: two sessions where the same lesson was taught in
 * different words both see an empty corpus, both classify NOVEL, and the same
 * PR carries two near-identical `add`s that no classifier ever compared.
 *
 * What is indexed here is *proposed*, not merged — the PR may still be
 * rejected — so the rows are marked pending (12-wire-contracts.md's
 * `signposts.is_pending`), which is how `classify` gets to see that a
 * neighbour is not yet approved.
 *
 * Pending rows belong to the run that wrote them, which is what `clear` is
 * for. Nothing downstream ever removes them: a proposal that was rejected
 * changes neither the merged corpus nor its hash, so no rebuild is triggered
 * and none would delete the row anyway. Left in place it would be retrieved by
 * every future run as though someone had approved it.
 */
export interface PendingIndexPort {
  /**
   * Index these proposals for `repo`, so later sessions retrieve them as
   * pending, each carrying whether a person is still holding it.
   */
  indexPending(repo: string, proposals: readonly PendingProposal[]): Promise<void>;
  /** Drop every pending row for `repo`, whatever run left it there. */
  clear(repo: string): Promise<void>;
}

/** Facts about what is already recorded for a repo, read once per run. */
export interface SignpostIndexPort {
  /** Every signpost id in use, so generated slugs do not collide. */
  existingIds(repo: string): Promise<Set<string>>;
  /** Whether this is the repo's first run — everything gates to a human if so. */
  isBootstrap(repo: string): Promise<boolean>;
  /** One recorded signpost by id, for `resolve_conflict`'s "existing claim". */
  byId(repo: string, id: string): Promise<Signpost | undefined>;
}

export interface CommitInput {
  repo: string;
  repoRoot: string;
  sessionId: string;
  operations: readonly Operation[];
}

/**
 * Where a session's proposals ended up: a commit on the developer's signposts
 * branch, in the worktree, and nowhere else yet.
 *
 * A run used to push and open the pull request itself, so the first thing a
 * developer saw after a successful run was a PR on their repository that
 * nobody had asked for (19-value-to-a-user.md, open item 1). The push and the
 * PR are `signpost publish` now, run once the developer has seen what was
 * proposed and said yes — see src/io/commit/publish.ts.
 */
export interface CommitOutcome {
  branch: string;
  /**
   * The open pull request this branch already has, which `publish` will add
   * to. Null when it has none and `publish` will open one. The commit is not
   * on it either way until `publish` pushes.
   */
  pr: number | null;
}

/**
 * Node 10: write markdown, regenerate the index and commit it to the
 * developer's signposts branch. A port because all of that is git and
 * filesystem work that belongs outside the graph.
 */
export interface CommitPort {
  apply(input: CommitInput): Promise<void>;
}

export interface GraphPorts {
  model: ModelProvider;
  gutter: GutterPort;
  neighbours: NeighbourPort;
  pendingIndex: PendingIndexPort;
  index: SignpostIndexPort;
  commit: CommitPort;
  /**
   * Optional, and absent rather than null-returning in the two harnesses that
   * predate it: a fake that does not model conventions is judging candidates
   * exactly as a repo with no CLAUDE.md would be.
   */
  conventions?: ConventionsPort;
  /** REAL `git config user.email` — written into provenance, never a pseudonym. */
  author: string;
  /** Injected so provenance dates are deterministic under test. */
  now(): Date;
}
