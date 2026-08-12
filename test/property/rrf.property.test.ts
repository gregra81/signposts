// P7 (16-build-plan.md): fusing a ranking against itself preserves
// relative order; a document ranked last in both input rankings never
// reaches the top of the fused ranking.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { fuseRrf } from "../../src/core/retrieval/rrf.js";

const idsArb = fc.uniqueArray(fc.string({ minLength: 1, maxLength: 10 }), { minLength: 1, maxLength: 20 });

describe("fuseRrf property tests", () => {
  it("P7a: fusing a ranking against itself preserves relative order", () => {
    fc.assert(
      fc.property(idsArb, (ids) => {
        const fused = fuseRrf(ids, ids);
        expect(fused.map((entry) => entry.id)).toEqual(ids);
      }),
    );
  });

  it("P7b: a document ranked last in both input rankings never reaches the top of the fused ranking", () => {
    // Two genuinely different rankings of the same id set, sharing only
    // their last-ranked element — not `ids` fused against itself (that's
    // already covered by P7a and never exercises R5's real claim).
    const rankingPairArb = idsArb
      .filter((ids) => ids.length > 1)
      .chain((ids) => {
        const last = ids[ids.length - 1]!;
        const rest = ids.slice(0, -1);
        return fc
          .shuffledSubarray(rest, { minLength: rest.length, maxLength: rest.length })
          .map((shuffledRest) => ({ first: ids, second: [...shuffledRest, last] }));
      });

    fc.assert(
      fc.property(rankingPairArb, ({ first, second }) => {
        const fused = fuseRrf(first, second);
        const lastId = first[first.length - 1]!;
        expect(fused[0]?.id).not.toBe(lastId);
      }),
    );
  });
});
