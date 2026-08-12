import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeCorpusHash } from "../../../src/core/retrieval/corpus-hash.js";

describe("computeCorpusHash", () => {
  const a = { id: "alpha", content_hash: "hash-a" };
  const b = { id: "bravo", content_hash: "hash-b" };
  const c = { id: "charlie", content_hash: "hash-c" };

  it("is order-independent: any permutation of the same set produces the same hash", () => {
    const forward = computeCorpusHash([a, b, c]);
    const reversed = computeCorpusHash([c, b, a]);
    const shuffled = computeCorpusHash([b, a, c]);
    expect(reversed).toBe(forward);
    expect(shuffled).toBe(forward);
  });

  it("changes when one id's content_hash changes", () => {
    const before = computeCorpusHash([a, b]);
    const after = computeCorpusHash([a, { ...b, content_hash: "hash-b-changed" }]);
    expect(after).not.toBe(before);
  });

  it("changes when a signpost is added or removed", () => {
    const withTwo = computeCorpusHash([a, b]);
    const withThree = computeCorpusHash([a, b, c]);
    expect(withThree).not.toBe(withTwo);
  });

  it("handles an empty list without throwing, and is stable", () => {
    expect(() => computeCorpusHash([])).not.toThrow();
    expect(computeCorpusHash([])).toBe(computeCorpusHash([]));
  });

  it("matches sha256 over the sorted, colon-joined, newline-joined pairs", () => {
    const expected = createHash("sha256").update("alpha:hash-a\nbravo:hash-b\ncharlie:hash-c").digest("hex");
    expect(computeCorpusHash([c, a, b])).toBe(expected);
  });

  it("does not mutate the input array", () => {
    const input = [c, a, b];
    const copy = [...input];
    computeCorpusHash(input);
    expect(input).toEqual(copy);
  });
});
