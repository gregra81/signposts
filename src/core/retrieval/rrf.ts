// Pure Reciprocal Rank Fusion over two rank-ordered id lists. See
// 05-retrieval.md "Hybrid search" — score(d) = Σ 1/(RRF_K + rank_i(d)),
// summed only over the lists that rank d at all. Missing from a list is an
// omitted term, not a zero rank. Fuses by rank position only — never reads
// or touches the underlying cosine-similarity/distance/BM25 value.

import { RRF_K } from "../config/constants.js";

export interface FusedResult {
  id: string;
  score: number;
}

/** Fuses two rank-ordered id lists (best first) into one score-ordered list, best first. */
export function fuseRrf(a: readonly string[], b: readonly string[]): FusedResult[] {
  const scores = new Map<string, number>();

  for (const ranking of [a, b]) {
    ranking.forEach((id, index) => {
      const rank = index + 1;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank));
    });
  }

  return [...scores.entries()].map(([id, score]) => ({ id, score })).sort((x, y) => y.score - x.score);
}
