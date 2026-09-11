// The hosted-PR surface (15-spec.md D1): the only part of the write path that
// is not plain git. Branch, commit and push are real git (src/io/git/), and a
// forge failure never fails a run — see src/io/commit/commit-port.ts.

/** A pull request this developer's branch prefix already has. */
export interface ForgeBranch {
  branch: string;
  number: number;
  /** Still open, so this session's proposals belong on it. Closed and merged are both false. */
  open: boolean;
}

export interface Forge {
  /**
   * Every pull request whose head branch starts with `prefix`, newest first.
   *
   * Closed and merged ones are included, because they are what says a branch
   * name has already been used — `pickBranch` needs both halves of that: which
   * branch is under review, and which names are spent.
   */
  branchesUnder(prefix: string): Promise<ForgeBranch[]>;
  /**
   * Opens the pull request and reports both halves of what `gh pr create`
   * printed. The URL was being parsed for the number and then discarded, and
   * it is the one thing a person actually wants out of a finished run
   * (18-end-to-end-gaps.md, item 5).
   */
  openPr(input: { branch: string; title: string; body: string }): Promise<{ number: number; url: string }>;
  /**
   * The body of an open PR. A session appends its own section to what earlier
   * sessions wrote, so it has to read before it writes.
   */
  readPrBody(prNumber: number): Promise<string>;
  updatePr(prNumber: number, body: string): Promise<void>;
  setLabels(prNumber: number, labels: readonly string[]): Promise<void>;
}
