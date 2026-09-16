// Pure Reciprocal Rank Fusion over two rank-ordered id lists. See
// 05-retrieval.md "Hybrid search" — score(d) = Σ w_i/(RRF_K + rank_i(d)),
// summed only over the lists that rank d at all. Missing from a list is an
// omitted term, not a zero rank. Fuses by rank position only — never reads
// or touches the underlying cosine-similarity/distance/BM25 value.
//
// **The two lists are not weighted equally** (19-value-to-a-user.md item 9).
// The vector list answers the question this product actually asks — does this
// mean the same thing as that — and the lexical list is a backstop for the
// tokens an embedding represents badly: identifiers, file paths, env var names,
// error strings. So the lexical half breaks ties and rescues a rare token; it
// does not outvote meaning.
//
// Equal weights made it outvote meaning routinely. "Is it safe to apply schema
// changes to the pre-production environment" shares no content word with the
// signpost that answers it, which says "staging", and shares "schema",
// "changes", "environment" and "production" with four that do not. Even with
// stopwords dropped, four lexical coincidences at equal weight put the right
// answer last of five.

import { FTS_RRF_WEIGHT, RRF_K } from "../config/constants.ts";

export interface FusedResult {
  id: string;
  score: number;
}

/**
 * Fuses a vector ranking and a lexical ranking (each best first) into one
 * score-ordered list, best first. The lexical list contributes at
 * FTS_RRF_WEIGHT; the vector list at full weight.
 */
export function fuseRrf(vector: readonly string[], lexical: readonly string[]): FusedResult[] {
  const scores = new Map<string, number>();

  for (const [ranking, weight] of [
    [vector, 1] as const,
    [lexical, FTS_RRF_WEIGHT] as const,
  ]) {
    // Dedupe to each id's first (best) occurrence before scoring — a
    // ranking that repeats an id must not inflate its score past what one
    // legitimate occurrence would contribute.
    const seen = new Set<string>();
    ranking.forEach((id, index) => {
      if (seen.has(id)) {
        return;
      }
      seen.add(id);
      const rank = index + 1;
      scores.set(id, (scores.get(id) ?? 0) + weight / (RRF_K + rank));
    });
  }

  return [...scores.entries()].map(([id, score]) => ({ id, score })).sort((x, y) => y.score - x.score);
}
