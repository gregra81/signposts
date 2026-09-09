// The exit codes the CLI returns, transcribed from 12-wire-contracts.md's
// "Exit codes" table.
//
// Two of them are deliberately not failures, and 15-spec.md story 77 is why:
// a caller that treats non-zero as fatal — a hook, a CI step, a skill reading
// `$?` — would otherwise report a false alarm for the two outcomes signposts
// expects to have. `PR_CREATION_FAILED` says the expensive part is done and
// safe on a branch; `AWAITING_HUMAN` says a person still has to answer.
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
   * The session's work is committed to the local branch and no pull request
   * carries it: the push failed, or it landed and `gh` did not (no binary, no
   * token, a forge that could not be reached). The command that finishes the
   * job by hand is on stderr.
   */
  prCreationFailed: 4,
  /** Halted on `human_review`. Not a failure — see the module comment. */
  awaitingHuman: 5,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
