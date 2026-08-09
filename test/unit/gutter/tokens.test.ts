import { describe, expect, it } from "vitest";
import { estimateGutteredSessionTokens, estimateTokens } from "../../../src/core/gutter/tokens.js";
import type { GutteredTurn } from "../../../src/core/gutter/types.js";

const turn = (text: string, at = "2026-01-01T00:00:00Z"): GutteredTurn => ({
  role: "human",
  text,
  at,
});

describe("estimateTokens", () => {
  it("estimates chars/4, rounded up", () => {
    expect(estimateTokens("x".repeat(40))).toBe(10);
  });

  it("returns 0 for an empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("estimateGutteredSessionTokens", () => {
  it("sums estimateTokens across multiple turns", () => {
    const turns = [turn("x".repeat(40)), turn("x".repeat(20))];
    expect(estimateGutteredSessionTokens(turns)).toBe(15);
  });

  it("a turn with empty text contributes 0", () => {
    const turns = [turn("x".repeat(40)), turn("")];
    expect(estimateGutteredSessionTokens(turns)).toBe(10);
  });
});
