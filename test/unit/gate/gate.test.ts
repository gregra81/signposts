import { describe, expect, it } from "vitest";
import { gate, type Operation } from "../../../src/core/gate/gate.js";
import { AUTO_PUBLISH_CONFIDENCE } from "../../../src/core/config/constants.js";

const ABOVE = AUTO_PUBLISH_CONFIDENCE;
const BELOW = AUTO_PUBLISH_CONFIDENCE - 0.01;

// One case per row of 06-review-and-pr.md's gate table.
const cases: Array<[string, Operation, number, boolean, "auto" | "needsHuman"]> = [
  ["add, confidence >= threshold, not bootstrap — auto", { op: "add" }, ABOVE, false, "auto"],
  ["add, confidence >= threshold, bootstrap — needsHuman", { op: "add" }, ABOVE, true, "needsHuman"],
  ["add, confidence < threshold, not bootstrap — needsHuman", { op: "add" }, BELOW, false, "needsHuman"],
  ["add, confidence < threshold, bootstrap — needsHuman", { op: "add" }, BELOW, true, "needsHuman"],
  ["reinforce, confidence >= threshold, not bootstrap — auto", { op: "reinforce" }, ABOVE, false, "auto"],
  ["reinforce, confidence >= threshold, bootstrap — needsHuman", { op: "reinforce" }, ABOVE, true, "needsHuman"],
  ["reinforce, confidence < threshold, not bootstrap — auto (provenance-only)", { op: "reinforce" }, BELOW, false, "auto"],
  ["reinforce, confidence < threshold, bootstrap — needsHuman", { op: "reinforce" }, BELOW, true, "needsHuman"],
  ["refine, confidence >= threshold, not bootstrap — needsHuman", { op: "refine" }, ABOVE, false, "needsHuman"],
  ["refine, confidence >= threshold, bootstrap — needsHuman", { op: "refine" }, ABOVE, true, "needsHuman"],
  ["refine, confidence < threshold, not bootstrap — needsHuman", { op: "refine" }, BELOW, false, "needsHuman"],
  ["refine, confidence < threshold, bootstrap — needsHuman", { op: "refine" }, BELOW, true, "needsHuman"],
  ["supersede, confidence >= threshold, not bootstrap — needsHuman", { op: "supersede" }, ABOVE, false, "needsHuman"],
  ["supersede, confidence >= threshold, bootstrap — needsHuman", { op: "supersede" }, ABOVE, true, "needsHuman"],
  ["supersede, confidence < threshold, not bootstrap — needsHuman", { op: "supersede" }, BELOW, false, "needsHuman"],
  ["supersede, confidence < threshold, bootstrap — needsHuman", { op: "supersede" }, BELOW, true, "needsHuman"],
  ["retire, confidence >= threshold, not bootstrap — needsHuman", { op: "retire" }, ABOVE, false, "needsHuman"],
  ["retire, confidence >= threshold, bootstrap — needsHuman", { op: "retire" }, ABOVE, true, "needsHuman"],
  ["retire, confidence < threshold, not bootstrap — needsHuman", { op: "retire" }, BELOW, false, "needsHuman"],
  ["retire, confidence < threshold, bootstrap — needsHuman", { op: "retire" }, BELOW, true, "needsHuman"],
];

describe("gate", () => {
  it.each(cases)("%s", (_name, operation, confidence, isBootstrap, expected) => {
    expect(gate(operation, confidence, isBootstrap)).toBe(expected);
  });
});
