// The exit codes the CLI returns, transcribed from 12-wire-contracts.md's
// "Exit codes" table.
//
// One of them is deliberately not a failure, and 15-spec.md story 77 is why:
// a caller that treats non-zero as fatal — a hook, a CI step, a skill reading
// `$?` — would otherwise report a false alarm for an outcome signposts expects
// to have. `PR_CREATION_FAILED` says the expensive part is done and safe on a
// branch. `AWAITING_HUMAN` (5) went with the in-session review.
//
// Codes 2 (no credentials) and 3 (not a git repo) are in that table and are
// not emitted yet: everything that would use them currently reports through
// `fail` as an unexpected error. They are absent here rather than defined and
// unused, so that the union below stays the set of codes this build can
// actually return.

export const EXIT_CODES = {
  /** Success, or nothing to do. */
  ok: 0,
  /** Unexpected error — the only code that means something went wrong. */
  failure: 1,
  /**
   * `signpost publish` could not finish: the work is committed to the local
   * branch and no pull request carries it, because the push failed, or it
   * landed and `gh` did not (no binary, no token, a forge that could not be
   * reached). The command that finishes the job by hand is on stderr.
   */
  prCreationFailed: 4,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
