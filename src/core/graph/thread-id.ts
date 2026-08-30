// The checkpoint thread id (04-extraction-graph.md "Durability",
// 12-wire-contracts.md).
//
//   threadId = `${repo}:${sessionId}:${contentHash}`
//
// Every component is already on disk or derivable from it, which is the
// whole point: a human may answer `human_review`'s interrupt three days
// later, in a different process, and nothing holds this string in memory
// across that gap. `signpost resume` recomputes it from the transcript it
// finds rather than looking up something it remembered.
//
// Including `contentHash` is what makes a resume safe. A transcript edited
// since the interrupt hashes differently and is therefore a *different*
// thread, so a resumed run can never gutter different bytes than the run
// that was interrupted. It also makes a re-run of an unchanged session a
// no-op, since it lands on a thread that has already finished.

export interface ThreadIdParts {
  /** "owner/name", from the git remote. */
  repo: string;
  sessionId: string;
  /** sha256 of the raw transcript file. */
  contentHash: string;
}

export const THREAD_ID_SEPARATOR = ":";

export function buildThreadId({ repo, sessionId, contentHash }: ThreadIdParts): string {
  return [repo, sessionId, contentHash].join(THREAD_ID_SEPARATOR);
}
