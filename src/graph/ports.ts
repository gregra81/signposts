// The edges the extraction graph talks to. Every one of these is IO the graph
// itself must not do: reading a transcript off disk, querying the signpost
// mirror, writing markdown and opening a pull request.
//
// They are declared here as interfaces, wired at the composition root, and
// substituted with fakes in tests — the same pattern as src/app.ts's `Ports`.
// Nothing in src/graph/ constructs one.

import type { GutteredSession } from "../core/gutter/types.ts";
import type { Candidate, NeighbourSignpost, Operation } from "../core/contracts/graph.ts";
import type { ModelProvider, ToolRunner } from "../core/model/types.ts";
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
  /** Index these proposals for `repo`, so later sessions retrieve them as pending. */
  indexPending(repo: string, signposts: readonly Signpost[]): Promise<void>;
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
 * Node 10: write markdown, regenerate the index, reindex embeddings, open or
 * update the PR. A port because all of that is git, filesystem and forge work
 * that belongs outside the graph.
 */
export interface CommitPort {
  apply(input: CommitInput): Promise<void>;
}

/**
 * The read-only tools `resolve_conflict` is given at Phase 4.5
 * (12-wire-contracts.md). A port because every one of them is filesystem or
 * subprocess work, and because the confinement that makes them safe needs a
 * real `realpath` — see src/io/tools/repo-tools.ts.
 */
export interface RepoToolsPort {
  /**
   * A runner for one checkout. `repoRoot` comes from graph state; every path
   * the model then supplies is confined against it before anything is read.
   */
  forRepo(repoRoot: string): ToolRunner;
}

export interface GraphPorts {
  model: ModelProvider;
  gutter: GutterPort;
  neighbours: NeighbourPort;
  pendingIndex: PendingIndexPort;
  index: SignpostIndexPort;
  commit: CommitPort;
  tools: RepoToolsPort;
  /** REAL `git config user.email` — written into provenance, never a pseudonym. */
  author: string;
  /** Injected so provenance dates are deterministic under test. */
  now(): Date;
}
