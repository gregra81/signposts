import { describe, expect, it } from "vitest";

// src/core has no logic yet (Slice A step 1 — see 16-build-plan.md), so
// there is nothing real to unit-test here yet. Step 2 replaces this
// with real src/core unit tests once eligibility/gutter/redact/etc.
// land. Until then, do not delete this file: test/unit/ empty means
// Stryker's mutation dry run (scoped to test/unit/**, see
// stryker.config.mjs) finds zero tests and `pnpm mutate` fails hard.
describe("test/unit placeholder", () => {
  it("placeholder — keeps test/unit non-empty so Stryker's dry run has a test to execute", () => {
    expect(1 + 1).toBe(2);
  });
});
