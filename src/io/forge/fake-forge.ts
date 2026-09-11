// Fake Forge port for tests (15-spec.md "The seam": "ports.forge -> records
// openPr / updatePr / setLabels; returns a synthetic PR number"). Hand-
// written, no mocking framework — records every call so a test can assert
// on what reached the forge, per 15-spec.md's "What a good test is here".

import type { Forge, ForgeBranch } from "./forge.ts";

export interface OpenPrCall {
  branch: string;
  title: string;
  body: string;
}

export interface UpdatePrCall {
  prNumber: number;
  body: string;
}

export interface SetLabelsCall {
  prNumber: number;
  labels: readonly string[];
}

/** What a synthetic pull request's URL looks like. Shaped like `gh`'s, not real. */
export const FAKE_PR_URL_PREFIX = "https://github.example/acme/api/pull/";

export class FakeForge implements Forge {
  readonly openPrCalls: OpenPrCall[] = [];
  readonly updatePrCalls: UpdatePrCall[] = [];
  readonly setLabelsCalls: SetLabelsCall[] = [];

  /** Newest first, the order `branchesUnder` promises. */
  private readonly prs: ForgeBranch[] = [];
  private readonly bodies = new Map<number, string>();
  private nextPrNumber = 1;

  async branchesUnder(prefix: string): Promise<ForgeBranch[]> {
    return this.prs.filter((pr) => pr.branch.startsWith(prefix)).map((pr) => ({ ...pr }));
  }

  async openPr(input: OpenPrCall): Promise<{ number: number; url: string }> {
    this.openPrCalls.push(input);
    const prNumber = this.nextPrNumber;
    this.nextPrNumber += 1;
    this.prs.unshift({ branch: input.branch, number: prNumber, open: true });
    this.bodies.set(prNumber, input.body);
    return { number: prNumber, url: `${FAKE_PR_URL_PREFIX}${String(prNumber)}` };
  }

  /**
   * Merges (or closes) the pull request on `branch` — the event that ends a
   * cycle. The branch keeps its pull request, which is what tells the next
   * session the name is spent.
   */
  merge(branch: string): void {
    const pr = this.prs.find((candidate) => candidate.branch === branch);
    if (pr === undefined) {
      throw new Error(`FakeForge: no pull request on ${branch} to merge`);
    }
    pr.open = false;
  }

  async readPrBody(prNumber: number): Promise<string> {
    return this.bodies.get(prNumber) ?? "";
  }

  async updatePr(prNumber: number, body: string): Promise<void> {
    this.updatePrCalls.push({ prNumber, body });
    this.bodies.set(prNumber, body);
  }

  async setLabels(prNumber: number, labels: readonly string[]): Promise<void> {
    this.setLabelsCalls.push({ prNumber, labels });
  }
}
