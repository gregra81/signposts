// Fake Forge port for tests (15-spec.md "The seam": "ports.forge -> records
// openPr / updatePr / setLabels; returns a synthetic PR number"). Hand-
// written, no mocking framework — records every call so a test can assert
// on what reached the forge, per 15-spec.md's "What a good test is here".

import type { Forge } from "./forge.ts";

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

export class FakeForge implements Forge {
  readonly openPrCalls: OpenPrCall[] = [];
  readonly updatePrCalls: UpdatePrCall[] = [];
  readonly setLabelsCalls: SetLabelsCall[] = [];

  private readonly openPrsByBranch = new Map<string, number>();
  private readonly bodies = new Map<number, string>();
  private nextPrNumber = 1;

  async hasOpenPr(branch: string): Promise<number | null> {
    return this.openPrsByBranch.get(branch) ?? null;
  }

  async openPr(input: OpenPrCall): Promise<number> {
    this.openPrCalls.push(input);
    const prNumber = this.nextPrNumber;
    this.nextPrNumber += 1;
    this.openPrsByBranch.set(input.branch, prNumber);
    this.bodies.set(prNumber, input.body);
    return prNumber;
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
