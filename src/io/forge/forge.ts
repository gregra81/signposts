// The hosted-PR surface (15-spec.md D1): the only part of the write path that
// is not plain git. Branch, commit and push are real git (src/io/git/), and a
// forge failure never fails a run — see src/io/commit/commit-port.ts.

export interface Forge {
  /** The open PR number for `branch`, or null if none exists. */
  hasOpenPr(branch: string): Promise<number | null>;
  openPr(input: { branch: string; title: string; body: string }): Promise<number>;
  /**
   * The body of an open PR. A session appends its own section to what earlier
   * sessions wrote, so it has to read before it writes.
   */
  readPrBody(prNumber: number): Promise<string>;
  updatePr(prNumber: number, body: string): Promise<void>;
  setLabels(prNumber: number, labels: readonly string[]): Promise<void>;
}
