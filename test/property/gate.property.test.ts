// Property test for gate() (06-review-and-pr.md, 16-build-plan.md P9).

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { gate, type Operation } from "../../src/core/gate/gate.js";

const opArb: fc.Arbitrary<Operation> = fc.constantFrom("add", "reinforce", "refine", "supersede", "retire").map(
  (op) => ({ op }) as Operation,
);

describe("gate property tests", () => {
  it("P9: gate partitioning — every operation lands in exactly one of auto / needsHuman, never both, never neither", () => {
    fc.assert(
      fc.property(opArb, fc.double({ min: 0, max: 1, noNaN: true }), fc.boolean(), (operation, confidence, isBootstrap) => {
        const result = gate(operation, confidence, isBootstrap);
        expect(result === "auto" || result === "needsHuman").toBe(true);
      }),
    );
  });
});
