// Pure "fused RRF score + path-overlap boost → ranking value" step. See
// 05-retrieval.md "Hybrid search" and "Filter before you search" (#3): the
// boost is additive to the fused score, never a tie-break-only signal and
// never a filter.

import { PATH_OVERLAP_BOOST_WEIGHT } from "../config/constants.js";

/**
 * Combines a fused RRF score with a path-overlap match count into one value
 * to sort neighbours by, descending. The match count is clamped to at most
 * 1 before weighting: PATH_OVERLAP_BOOST_WEIGHT's sizing reasoning assumes a
 * single shared path, so multiple overlapping paths must not compound past
 * that — overlap is a binary "did any path match" signal here, not a
 * magnitude.
 */
export function combineScore(rrfScore: number, boost: number): number {
  return rrfScore + PATH_OVERLAP_BOOST_WEIGHT * Math.min(boost, 1);
}
