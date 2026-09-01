// Behaviour test proving the real embedder is semantically meaningful, not
// just "produces a 384-dim vector" — real transformers.js pipeline against
// the pinned model, no mocking, per 16-build-plan.md's "no test-double
// framework" rule. This downloads the ~23MB quantized model on first run in
// a given environment; a shared `modelCacheDir` across this file's one test
// keeps that to once.
//
// Without this test, a degenerate embedder (e.g. one returning a constant
// vector, or one that ignores its input) would still pass vector-index.test.ts's
// "produces EMBEDDING_DIM numbers" checks. This asserts the numbers actually
// encode meaning: two differently-worded claims about the same fact land
// closer together than two claims about unrelated facts.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cosineSimilarity } from "../../../src/core/retrieval/cosine-similarity.js";
import { EMBEDDING_MODEL } from "../../../src/core/config/constants.js";
import { createEmbedder } from "../../../src/io/embed/embedder.js";
import { testLocalModelPath, testModelCache } from "../../support/model-cache.js";

const modelCacheRoot = testModelCache();

afterAll(() => {
});

describe("embedder semantics", () => {
  it(
    "places two differently-worded claims about the same fact closer than an unrelated claim",
    async () => {
      const embedder = await createEmbedder({
        modelCacheDir: modelCacheRoot,
        allowRemoteModels: false,
        localModelPath: testLocalModelPath(),
        embeddingModel: EMBEDDING_MODEL,
      });

      const claimA = "The staging database is read-only; run migrations against dev instead.";
      const claimB = "Do not run migrations on staging, it is a read-only environment.";
      const claimC = "The Prisma schema lives at prisma/schema.prisma, not schema/prisma.";

      const vectors = await embedder.embed([claimA, claimB, claimC]);
      const [vecA, vecB, vecC] = [vectors[0]!, vectors[1]!, vectors[2]!];

      const relatedSim = cosineSimilarity(vecA, vecB);
      const unrelatedSim = cosineSimilarity(vecA, vecC);

      // A degenerate embedder (constant output, or one that ignores input)
      // would put relatedSim and unrelatedSim at or near the same value —
      // this margin is well above realistic noise for this model but would
      // catch that failure mode.
      expect(relatedSim).toBeGreaterThan(unrelatedSim + 0.3);
      expect(relatedSim).toBeGreaterThan(0.5);
    },
    120_000,
  );
});
