import { describe, expect, it } from "vitest";
import { FTS_RRF_WEIGHT, RRF_K } from "../../../src/core/config/constants.js";
import { fuseRrf } from "../../../src/core/retrieval/rrf.js";

describe("fuseRrf", () => {
  it("scores a document present in both lists as the sum of both weighted reciprocal ranks", () => {
    const fused = fuseRrf(["a", "b"], ["a", "c"]);
    const a = fused.find((entry) => entry.id === "a");
    // The lexical term carries FTS_RRF_WEIGHT and the vector term does not —
    // see rrf.ts on why the two halves are not equally informative.
    expect(a?.score).toBeCloseTo(1 / (RRF_K + 1) + FTS_RRF_WEIGHT / (RRF_K + 1), 10);
  });

  it("weights an id the lexical list alone ranked below the same rank in the vector list", () => {
    // The backstop-not-a-vote rule, as arithmetic: "v" at vector rank 1 and
    // "l" at lexical rank 1 are the same position in their own list, and "v"
    // has to win. Equal weights made these a tie and let BM25 decide ordinary
    // queries on shared words (19-value-to-a-user.md item 9).
    const fused = fuseRrf(["v"], ["l"]);
    expect(fused.map((entry) => entry.id)).toEqual(["v", "l"]);
  });

  it("omits a term for a document missing from one list, rather than treating it as zero-ranked", () => {
    // "b" is rank 2 in the vector list and absent from the FTS list. If
    // absence were scored as a very high rank number (not omitted), its
    // score would be lower than this — this pins the "omitted" behaviour.
    const fused = fuseRrf(["a", "b"], ["a"]);
    const b = fused.find((entry) => entry.id === "b");
    expect(b?.score).toBeCloseTo(1 / (RRF_K + 2), 10);
  });

  it("orders by fused score descending", () => {
    const fused = fuseRrf(["a", "b"], ["a", "c"]);
    // "a" is ranked first in both lists, so it outscores "b" and "c",
    // which each appear in only one list.
    expect(fused[0]?.id).toBe("a");
    expect(fused[0]!.score).toBeGreaterThan(fused[1]!.score);
  });

  it("orders by score even when insertion order (first list, then second) contradicts it", () => {
    // "b" is inserted into the score map before "a" (it's first in the first
    // list), but "a" outscores it — rank 1 in the second list plus rank 2 in
    // the first, vs. "b"'s single rank-1 term. This only passes if the
    // result is actually sorted by score, not left in Map insertion order.
    const fused = fuseRrf(["b", "a"], ["a"]);
    expect(fused.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("returns an empty list for two empty inputs", () => {
    expect(fuseRrf([], [])).toEqual([]);
  });

  it("dedupes a repeated id within one ranking to its first occurrence, not inflating its score", () => {
    // "a" appears at rank 1 and rank 3 in the first list — only rank 1
    // (its first occurrence) should count, so its score must equal the
    // same list fused against a single, non-duplicated occurrence.
    const withDuplicate = fuseRrf(["a", "b", "a"], []);
    const withoutDuplicate = fuseRrf(["a", "b"], []);
    const a = withDuplicate.find((entry) => entry.id === "a");
    expect(a?.score).toBeCloseTo(1 / (RRF_K + 1), 10);
    expect(a?.score).toBeCloseTo(withoutDuplicate.find((entry) => entry.id === "a")!.score, 10);
  });

  it("pins the exact closed-form score for a hand-computed case", () => {
    // "z" is rank 2 in the vector list and rank 4 in the lexical one.
    const fused = fuseRrf(["w", "z"], ["p", "q", "r", "z"]);
    const z = fused.find((entry) => entry.id === "z");
    expect(z?.score).toBeCloseTo(1 / (RRF_K + 2) + FTS_RRF_WEIGHT / (RRF_K + 4), 10);
  });
});
