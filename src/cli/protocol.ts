// The JSON `signpost sessions`, `signpost run` and `signpost resume` print:
// one object per invocation, on stdout.
//
// This is the contract the skill is written against. The rule it follows:
// everything the caller needs in order to answer is in the output that asked
// — the node, both turns, and the schema the answer must satisfy — so
// answering never requires knowing anything signposts did not just say.

import type { PendingRequest } from "../graph/index.ts";

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

export type RunStatus = "waiting" | "finished";

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
}
