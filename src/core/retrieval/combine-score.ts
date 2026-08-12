// Pure "fused RRF score + path-overlap boost → ranking value" step. See
// 05-retrieval.md "Hybrid search" and "Filter before you search" (#3): the
// boost is additive to the fused score, never a tie-break-only signal and
// never a filter.

import { PATH_OVERLAP_BOOST_WEIGHT } from "../config/constants.js";

/**
 * Combines a fused RRF score with a path-overlap match into one value to
 * sort neighbours by, descending. `boost` is binary — "did any path
 * match" — not a magnitude, so no clamp is needed here:
 * PATH_OVERLAP_BOOST_WEIGHT's sizing reasoning assumes a single shared
 * path, and multiple overlapping paths must not compound past that.
 */
export function combineScore(rrfScore: number, boost: boolean): number {
  return rrfScore + PATH_OVERLAP_BOOST_WEIGHT * (boost ? 1 : 0);
}
