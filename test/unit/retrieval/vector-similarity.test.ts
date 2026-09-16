import { describe, expect, it } from "vitest";
import { cosineSimilarity } from "../../../src/core/retrieval/cosine-similarity.js";
import { cosineFromL2Distance } from "../../../src/core/retrieval/vector-similarity.js";

function l2(a: readonly number[], b: readonly number[]): number {
  return Math.sqrt(a.reduce((sum, x, i) => sum + (x - b[i]!) ** 2, 0));
}

function unit(v: readonly number[]): number[] {
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  return v.map((x) => x / norm);
}

describe("cosineFromL2Distance", () => {
  it("is 1 for identical unit vectors, 0 for orthogonal ones and -1 for opposite ones", () => {
    // The three fixed points of cos = 1 - d²/2 over unit vectors: d = 0, √2, 2.
    expect(cosineFromL2Distance(0)).toBe(1);
    expect(cosineFromL2Distance(Math.SQRT2)).toBeCloseTo(0, 12);
    expect(cosineFromL2Distance(2)).toBe(-1);
  });

  it("agrees with cosine similarity computed directly, for unit vectors", () => {
    // What the read-path floor relies on: vec0 hands back an L2 distance, and
    // thresholding its conversion has to mean the same as thresholding cosine.
    const pairs: Array<[number[], number[]]> = [
      [unit([1, 2, 3]), unit([3, 2, 1])],
      [unit([0.2, -0.7, 0.1, 0.4]), unit([0.3, -0.5, 0.2, 0.9])],
      [unit([5, 0, -1]), unit([-2, 4, 1])],
    ];
    for (const [a, b] of pairs) {
      expect(cosineFromL2Distance(l2(a, b))).toBeCloseTo(cosineSimilarity(a, b), 12);
    }
  });
});
