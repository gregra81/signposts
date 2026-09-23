// The JSON `signpost sessions`, `signpost run` and `signpost resume` print:
// one object per invocation, on stdout.
//
// This is the contract the skill is written against. The rule it follows:
// everything the caller needs in order to answer is in the output that asked
// — the node, both turns, and the schema the answer must satisfy — so
// answering never requires knowing anything signposts did not just say.

import type { PendingRequest } from "../graph/index.ts";
import type { CommitOutcome } from "../graph/ports.ts";
import type { PublishOutcome } from "./run-port.ts";

/** Everything about a session the caller hands back to continue it. */
export interface SessionRef {
  sessionId: string;
  contentHash: string;
  transcriptPath: string;
}

export interface SessionsOutput {
  /** Eligible for extraction, oldest activity first. */
  sessions: SessionRef[];
}

/**
 * `skipped` is a transcript that can never be extracted — empty, every line a
 * sidechain, or one a redactor fails on. It is recorded as judged and will not
 * be offered again, and it is not a failure: `reason` says which.
 */
export type RunStatus = "waiting" | "finished" | "skipped";

export interface RunOutput {
  sessionId: string;
  /**
   * Half of the thread id, and the half that cannot be re-derived safely: the
   * transcript grows while the halt is unanswered. It travels with every halt
   * for the rule above — the subagent driving the loop is given a session id
   * and nothing else, so a `--content-hash` it had to fetch from an earlier
   * `sessions` listing is one it does not have.
   */
  contentHash: string;
  status: RunStatus;
  /** Non-empty exactly when `status` is "waiting": answer every one of these. */
  pending: PendingRequest[];
  /** What a finished session proposed, one line each. Empty while waiting. */
  proposed: string[];
  /**
   * Where those proposals went: a commit on the developer's signposts branch,
   * not yet pushed, and the pull request `signpost publish` will add it to.
   * Null when this invocation committed nothing — it halted, or the session
   * produced no operations.
   */
  commit: CommitOutcome | null;
  /**
   * How many times the critic rejected enough of a batch to send it back to
   * `extract`. Absent when it never did, which is the ordinary case.
   *
   * A retry replaces the batch, so what a session proposes afterwards is a
   * second pass over the same transcript, and a run that re-extracted is one
   * whose shorter list of proposals has a reason. Nothing reported that
   * (19-value-to-a-user.md, the item left open beside the retry fix).
   */
  reExtracted?: number;
  /** Why the session was skipped. Present exactly when `status` is "skipped". */
  reason?: string;
}

/**
 * What `signpost publish` prints. `nothing` means the branch had no commit the
 * remote lacks — no run committed anything since the last publish.
 */
export interface PublishOutput {
  status: "published" | "nothing";
  publish: PublishOutcome | null;
}
