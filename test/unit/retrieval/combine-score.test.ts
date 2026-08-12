// Unit tests for the pure "fused RRF score + path-overlap boost → ranking
// value" step (R3). Numbers below are real RRF_K values — score at rank r
// is 1/(RRF_K+r), summed once per list a doc appears in — so gaps here are
// exactly what findNeighbours would see for docs at those ranks in both
// the vector and FTS lists, not made-up numbers.

import { describe, expect, it } from "vitest";
import { RRF_K } from "../../../src/core/config/constants.js";
import { combineScore } from "../../../src/core/retrieval/combine-score.js";

const rrfScoreAtRankBothLists = (rank: number): number => 2 / (RRF_K + rank);

describe("combineScore", () => {
  it("a lower-score, path-matching candidate outranks a higher-score, non-matching one when the gap is small enough to close", () => {
    // rank1 vs rank2 in both lists: gap ≈ 0.000529, smaller than the boost weight.
    const higherRankNoMatch = combineScore(rrfScoreAtRankBothLists(1), false);
    const lowerRankWithMatch = combineScore(rrfScoreAtRankBothLists(2), true);

    expect(lowerRankWithMatch).toBeGreaterThan(higherRankNoMatch);
  });

  it("preserves pure RRF order when neither candidate has a path match", () => {
    const rank1 = combineScore(rrfScoreAtRankBothLists(1), false);
    const rank2 = combineScore(rrfScoreAtRankBothLists(2), false);

    expect(rank1).toBeGreaterThan(rank2);
  });

  it("does not let a path match invert a large RRF score gap", () => {
    // rank1 vs rank6 in both lists: gap ≈ 0.002484, larger than the boost weight.
    const higherRankNoMatch = combineScore(rrfScoreAtRankBothLists(1), false);
    const lowerRankWithMatch = combineScore(rrfScoreAtRankBothLists(6), true);

    expect(higherRankNoMatch).toBeGreaterThan(lowerRankWithMatch);
  });
});
