// The guard that tells the two halts apart.
//
// A caller reads a pending request out of a checkpoint and has to decide
// whether it is asking for an answer from the model or a decision from a
// person. Getting that wrong sends a review to be answered as a
// classification, so the guard is exhaustive about what is not a model
// request rather than trusting the shape it was handed.

import { describe, expect, it } from "vitest";
import { hostModel, isModelRequest, MODEL_REQUEST_KIND } from "../../../src/graph/host-model.js";
import { REVIEW_REQUEST_KIND } from "../../../src/graph/nodes/human-review.js";

describe("isModelRequest", () => {
  it("accepts a model request", () => {
    expect(
      isModelRequest({ kind: MODEL_REQUEST_KIND, node: "extract", system: "s", user: "u", schema: {} }),
    ).toBe(true);
  });

  it("rejects a review request", () => {
    expect(isModelRequest({ kind: REVIEW_REQUEST_KIND, repo: "acme/api", needsHuman: [] })).toBe(false);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", MODEL_REQUEST_KIND],
    ["a number", 1],
    ["an object with no kind", { node: "extract" }],
  ])("rejects %s", (_label, value) => {
    expect(isModelRequest(value)).toBe(false);
  });
});

describe("hostModel", () => {
  it("refuses to answer outside a run, rather than returning something invented", async () => {
    // `interrupt()` only means anything inside a graph with a checkpointer:
    // there is no other way for this provider to produce a reply, and a
    // silent fallback would be a fabricated answer.
    await expect(
      hostModel.structured({ node: "extract", system: "s", user: "u", schema: {} }),
    ).rejects.toThrow(/interrupt/i);
  });
});
