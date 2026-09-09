// The `gh pr create` command a developer runs when signposts could not open
// the pull request itself (06-review-and-pr.md, "Auth": "never fail the run
// over PR creation, because the extraction work is the expensive part and it
// is already done").
//
// It has to be *exact*, which means it has to survive being pasted into a
// shell. The title and the body are neither: the title contains a colon and
// spaces, and the body is a multi-line markdown table whose cells contain
// backticks, `|`, `#` and quotes from the evidence lines the model wrote. Any
// of those unquoted is a different command, and a body cut off at the first
// newline is a pull request nobody can review.
//
// So every argument is single-quoted, POSIX style: inside single quotes a
// shell interprets nothing at all, including newlines, and the only character
// that needs handling is the single quote itself — closed, escaped, reopened.
// That is why `'\''` and not a backslash: there is no escape character inside
// single quotes.
//
// Pure: an argument list in, one line of shell out.

const QUOTE = "'";

/** Everything a shell passes through untouched: a bare word needs no quotes. */
const BARE_WORD = /^[A-Za-z0-9_./:=-]+$/;

/** `it's` -> `'it'\''s'`. Safe for every byte, newlines included. */
function shellQuote(value: string): string {
  if (BARE_WORD.test(value)) {
    return value;
  }
  return `${QUOTE}${value.replaceAll(QUOTE, `${QUOTE}\\${QUOTE}${QUOTE}`)}${QUOTE}`;
}

export interface ManualPrInput {
  branch: string;
  title: string;
  body: string;
}

/**
 * The argument vector, before quoting — exported because it is what the
 * command is *for*: a test that runs the printed line through a shell asserts
 * the arguments that arrive are these.
 */
export function manualPrArgv(input: ManualPrInput): string[] {
  return [
    "gh",
    "pr",
    "create",
    "--head",
    input.branch,
    "--title",
    input.title,
    "--body",
    input.body,
  ];
}

/** One copy-pasteable line: `gh pr create --head … --title '…' --body '…'`. */
export function manualPrCommand(input: ManualPrInput): string {
  return manualPrArgv(input).map(shellQuote).join(" ");
}

/**
 * `git push --set-upstream origin <branch>` — the push the commit port ran
 * and could not finish.
 *
 * Runnable from the developer's own checkout, not only from the worktree: the
 * worktree is a linked one (src/io/git/worktree.ts), so the branch ref is in
 * the same repository and points at the same commit.
 */
export function manualPushCommand(branch: string): string {
  return ["git", "push", "--set-upstream", "origin", branch].map(shellQuote).join(" ");
}
