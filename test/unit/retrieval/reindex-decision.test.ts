import { describe, expect, it } from "vitest";
import { decideReindex, type ReindexDecisionInput } from "../../../src/core/retrieval/reindex-decision.js";

const base: ReindexDecisionInput = {
  indexExists: true,
  storedCorpusHash: "hash-1",
  currentCorpusHash: "hash-1",
  storedEmbeddingModel: "model-a",
  currentEmbeddingModel: "model-a",
};

describe("decideReindex", () => {
  // Full truth table over the 4 boolean-ish conditions: indexExists,
  // hash match, model match, and (both mismatch) combined.
  const cases: Array<{ name: string; input: ReindexDecisionInput; expected: "rebuild" | "skip" }> = [
    { name: "index missing -> rebuild", input: { ...base, indexExists: false }, expected: "rebuild" },
    { name: "hash match + model match -> skip", input: base, expected: "skip" },
    {
      name: "hash mismatch, model match -> rebuild",
      input: { ...base, currentCorpusHash: "hash-2" },
      expected: "rebuild",
    },
    {
      name: "hash match, model mismatch -> rebuild",
      input: { ...base, currentEmbeddingModel: "model-b" },
      expected: "rebuild",
    },
    {
      name: "hash mismatch and model mismatch -> rebuild",
      input: { ...base, currentCorpusHash: "hash-2", currentEmbeddingModel: "model-b" },
      expected: "rebuild",
    },
    {
      name: "index missing, hash and model would otherwise match -> rebuild",
      input: { ...base, indexExists: false, storedCorpusHash: null, storedEmbeddingModel: null },
      expected: "rebuild",
    },
    {
      name: "stored hash null (never indexed) but indexExists true -> rebuild",
      input: { ...base, storedCorpusHash: null },
      expected: "rebuild",
    },
    {
      name: "stored model null (never indexed) but indexExists true -> rebuild",
      input: { ...base, storedEmbeddingModel: null },
      expected: "rebuild",
    },
  ];

  it.each(cases)("$name", ({ input, expected }) => {
    expect(decideReindex(input)).toBe(expected);
  });
});
