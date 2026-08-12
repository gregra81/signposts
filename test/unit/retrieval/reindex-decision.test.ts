import { describe, expect, it } from "vitest";
import { shouldReindex, type ReindexDecisionInput } from "../../../src/core/retrieval/reindex-decision.js";

const base: ReindexDecisionInput = {
  indexExists: true,
  storedCorpusHash: "hash-1",
  currentCorpusHash: "hash-1",
  storedEmbeddingModel: "model-a",
  currentEmbeddingModel: "model-a",
};

describe("shouldReindex", () => {
  // Full truth table over the 4 boolean-ish conditions: indexExists,
  // hash match, model match, and (both mismatch) combined.
  const cases: Array<{ name: string; input: ReindexDecisionInput; expected: boolean }> = [
    { name: "index missing -> rebuild", input: { ...base, indexExists: false }, expected: true },
    { name: "hash match + model match -> skip", input: base, expected: false },
    {
      name: "hash mismatch, model match -> rebuild",
      input: { ...base, currentCorpusHash: "hash-2" },
      expected: true,
    },
    {
      name: "hash match, model mismatch -> rebuild",
      input: { ...base, currentEmbeddingModel: "model-b" },
      expected: true,
    },
    {
      name: "hash mismatch and model mismatch -> rebuild",
      input: { ...base, currentCorpusHash: "hash-2", currentEmbeddingModel: "model-b" },
      expected: true,
    },
    {
      name: "index missing, hash and model would otherwise match -> rebuild",
      input: { ...base, indexExists: false, storedCorpusHash: null, storedEmbeddingModel: null },
      expected: true,
    },
    {
      name: "stored hash null (never indexed) but indexExists true -> rebuild",
      input: { ...base, storedCorpusHash: null },
      expected: true,
    },
    {
      name: "stored model null (never indexed) but indexExists true -> rebuild",
      input: { ...base, storedEmbeddingModel: null },
      expected: true,
    },
  ];

  it.each(cases)("$name", ({ input, expected }) => {
    expect(shouldReindex(input)).toBe(expected);
  });
});
