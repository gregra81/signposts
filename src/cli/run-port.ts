// What a run command is handed, and where it comes from.
//
// The three run commands need resources whose lifetime is one invocation: a
// database handle, a checkpointer, and an embedder that loads an ONNX pipeline
// when it is built. None of that can be constructed eagerly at the composition
// root — `doctor` must run in a repo with no database, and `init` must not
// open one before consent — so what the root hands down is this: a function
// that opens them, and a handle that closes them again.
//
// That keeps R2 intact. The commands below construct nothing; production wires
// this in src/io/production-app.ts, and a test substitutes it at the same
// seam.

import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { ResolvedConfig } from "../core/config/resolve.ts";
import type { ExtractionGraph, GraphPorts } from "../graph/index.ts";
import type { CommitOutcome } from "../graph/ports.ts";

/** One eligible transcript — what `sessions` lists and `run` picks from. */
export interface RunSession {
  sessionId: string;
  contentHash: string;
  transcriptPath: string;
  lastActivityAt: Date;
}

/**
 * A session as a command settles it: the listed session, or one named back by a
 * halt whose transcript has since moved on. For the second kind the last
 * activity of the bytes the thread was built from is not known, and is `null`
 * rather than a guess (../cli/with-run.ts, `namedSession`).
 */
export interface SettledSession extends Omit<RunSession, "lastActivityAt"> {
  lastActivityAt: Date | null;
}

/** What a finished session is recorded as, so no later run picks it up again. */
export interface FinishedSession {
  sessionId: string;
  contentHash: string;
  /** `null` when unknown — see SettledSession. */
  lastActivityAt: Date | null;
  tokenEstimate: number | null;
}

/**
 * A session recorded as judged without being extracted, because its transcript
 * never can be (../core/errors/unusable-transcript.ts). `reason` is for the
 * caller; the record itself only has to stop the session being offered again.
 */
export interface SkippedSession {
  sessionId: string;
  contentHash: string;
  lastActivityAt: Date | null;
  reason: string;
}

export interface RunHandle {
  /** The "owner/name" key, from the origin remote. */
  repo: string;
  graph: ExtractionGraph;
  checkpointer: BaseCheckpointSaver;
  /** Proposals reach the next session through this — see runResume's report. */
  pendingIndex: GraphPorts["pendingIndex"];
  /** Eligible sessions for this repo, oldest activity first. */
  eligible(now: Date): RunSession[];
  /**
   * The branch this invocation's proposals were committed to, and the pull
   * request `publish` will add them to — or null when nothing was committed.
   *
   * Read off the handle rather than carried in the graph's state: the commit
   * port is what discovers it, and it belongs to this invocation.
   */
  commitOutcome(): CommitOutcome | null;
  /** Records a session as processed, and the repo as past its bootstrap run. */
  finish(session: FinishedSession): void;
  /**
   * Records a session as judged and not processed, so no later run offers it.
   * Unlike `finish` it does not end the bootstrap run: nothing was extracted,
   * so nothing has been through the gate.
   */
  skip(session: SkippedSession): void;
  /**
   * Brings the mirror and the index up to the signposts on disk, and reports
   * any file that would not parse.
   *
   * Called once at the start of a run (`run --first`). Safe anywhere — the
   * mirror spares pending rows (src/io/db/signposts.ts) — but a run only needs
   * it once. 18-end-to-end-gaps.md item 2 is what not calling it at all cost.
   */
  syncCorpus(): Promise<{ failures: string[] }>;
  close(): void;
}

/** Why a run could not be opened, phrased for the person who typed the command. */
export interface RunUnavailable {
  reason: string;
}

export type OpenedRun = { handle: RunHandle } | RunUnavailable;

export function isUnavailable(opened: OpenedRun): opened is RunUnavailable {
  return "reason" in opened;
}

export type OpenRun = (input: {
  config: ResolvedConfig;
  repoRoot: string;
  /** Where a step that could not finish says so. */
  warn: (message: string) => void;
}) => Promise<OpenedRun>;

/**
 * Where `signpost publish` put the work: the branch, the pull request, or the
 * reason there is none and the command that would finish it by hand.
 *
 * `pr` is null on two quite different outcomes and `reason` is what separates
 * them: a push that failed, and a push that worked with a forge that did not.
 * `url` is set only when this invocation opened the pull request — `gh pr
 * create` prints it, and a PR found by listing gives a number and no URL.
 */
export interface PublishOutcome {
  branch: string;
  /** How many sessions' commits this pushed. */
  sessions: number;
  /** The pull request the commits are on, once there is one. */
  pr: number | null;
  /** Its URL, when this invocation is the one that opened it. */
  url: string | null;
  /** Why there is no pull request, or why it could not be updated. Null if all is well. */
  reason: string | null;
  /**
   * The command that finishes the job by hand, when one is outstanding. The
   * exit code reads this field, so the JSON and the code cannot tell different
   * stories.
   */
  manualCommand: string | null;
}

/**
 * Pushes what the runs committed and opens or updates the pull request —
 * src/io/commit/publish.ts. Null when there was nothing to publish.
 *
 * A seam of its own rather than a method on the run handle: it needs a forge
 * and git, and none of the database, checkpointer or embedder `openRun` opens.
 */
export type Publish = (input: {
  config: ResolvedConfig;
  repoRoot: string;
  warn: (message: string) => void;
}) => Promise<PublishOutcome | null>;
