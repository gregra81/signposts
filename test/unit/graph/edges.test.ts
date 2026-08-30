// The four conditional edges of src/graph/graph.ts. Each reads a decision
// something else already made; these assert the mapping from that decision to
// a node name, which is the only thing the edges add.

import { describe, expect, it } from "vitest";
import { END } from "@langchain/langgraph";
import { afterCritic, afterGate, afterGutter, afterValidate } from "../../../src/graph/graph.js";
import { NODE_IDS } from "../../../src/graph/node-ids.js";
import {
  MAX_VALIDATE_ATTEMPTS,
  MIN_GUTTERED_TOKENS,
} from "../../../src/core/config/constants.js";
import { graphState } from "../../behaviour/graph/harness.js";
import type { Operation } from "../../../src/core/contracts/graph.js";

const RETIRE: Operation = { op: "retire", id: "staging-writable", reason: "Superseded." };

const withTokens = (tokenEstimate: number) =>
  graphState({ gutterStats: { tokenEstimate, humanTurns: 1, redactionCount: 0 } });

describe("afterGutter", () => {
  it("extracts from a transcript at the threshold", () => {
    expect(afterGutter(withTokens(MIN_GUTTERED_TOKENS))).toBe(NODE_IDS.extract);
  });

  it("ends the run on a transcript below it, without a model call", () => {
    expect(afterGutter(withTokens(MIN_GUTTERED_TOKENS - 1))).toBe(END);
  });
});

describe("afterCritic", () => {
  it("goes back to extract while a critique is present", () => {
    expect(afterCritic(graphState({ critique: "Too vague." }))).toBe(NODE_IDS.extract);
  });

  it("moves on to retrieval once the critique is gone", () => {
    expect(afterCritic(graphState({ critique: undefined }))).toBe(NODE_IDS.retrieveNeighbours);
  });
});

describe("afterValidate", () => {
  it("regenerates while there are errors and budget", () => {
    const state = graphState({ validationErrors: ["bad claim"], validateAttempts: 1 });

    expect(afterValidate(state)).toBe(NODE_IDS.extract);
  });

  it("carries on to the gate once the budget is spent", () => {
    const state = graphState({
      validationErrors: ["bad claim"],
      validateAttempts: MAX_VALIDATE_ATTEMPTS,
    });

    expect(afterValidate(state)).toBe(NODE_IDS.confidenceGate);
  });

  it("carries on to the gate when everything validated", () => {
    expect(afterValidate(graphState({ validationErrors: [] }))).toBe(NODE_IDS.confidenceGate);
  });
});

describe("afterGate", () => {
  it("halts for a person when the gate held something back", () => {
    const state = graphState({
      gated: { auto: [], needsHuman: [{ operation: RETIRE, reason: "deletes_existing" }] },
    });

    expect(afterGate(state)).toBe(NODE_IDS.humanReview);
  });

  it("commits directly when the gate held nothing back", () => {
    const state = graphState({ gated: { auto: [RETIRE], needsHuman: [] } });

    expect(afterGate(state)).toBe(NODE_IDS.commit);
  });
});
