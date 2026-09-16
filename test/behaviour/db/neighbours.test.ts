// Behaviour test for hybrid neighbour retrieval (R3-R5) — real
// better-sqlite3 file, real sqlite-vec extension, real FTS5, real
// transformers.js embedder against the pinned model. No mocking, per
// 16-build-plan.md's "no test-double framework" rule. This downloads the
// ~23MB quantized model on first run in a given environment; a
// `modelCacheDir` shared across this file's tests keeps that to once.

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMBEDDING_MODEL } from "../../../src/core/config/constants.js";
import { normalize } from "../../../src/core/retrieval/normalize.js";
import { createEmbedder, type Embedder } from "../../../src/io/embed/embedder.js";
import { openDb } from "../../../src/io/db/migrate.js";
import { rebuildIndex, type ActiveSignpost } from "../../../src/io/db/vector-index.js";
import { findNeighbours } from "../../../src/io/db/neighbours.js";
import { testLocalModelPath, testModelCache } from "../../support/model-cache.js";

const modelCacheRoot = testModelCache();
const retrieval = { allow_remote_models: false, local_model_path: testLocalModelPath() };

const platformSignposts: ActiveSignpost[] = [
  {
    id: "staging-db-read-only",
    content_hash: "hash-1",
    claim: "The staging database is read-only; run migrations against dev instead.",
    evidence: "A migration run against staging failed with a permissions error.",
  },
  {
    id: "prisma-schema-path",
    content_hash: "hash-2",
    claim: "The Prisma schema lives at prisma/schema.prisma, not schema/prisma.",
    evidence: "A generate step failed after looking in the wrong directory.",
  },
];

let embedder: Embedder;

async function insertSignpost(
  db: Database.Database,
  repo: string,
  s: ActiveSignpost,
  options: { status?: string; paths?: string[] } = {},
): Promise<void> {
  const scope = { repo, ...(options.paths ? { paths: options.paths } : {}) };
  db.prepare(
    `INSERT INTO signposts
      (id, repo, claim, category, evidence, scope_json, confidence, status, provenance_json, is_pending, content_hash, embedding_model, embedding_dim)
     VALUES (?, ?, ?, 'gotcha', ?, ?, 0.9, ?, '{}', 0, ?, '', 0)`,
  ).run(s.id, repo, s.claim, s.evidence, JSON.stringify(scope), options.status ?? "active", s.content_hash);
}

async function embedCandidate(claim: string): Promise<number[]> {
  const [vector] = await embedder.embed([normalize(claim)]);
  return vector!;
}

describe("findNeighbours", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "signposts-neighbours-db-"));
    db = openDb(path.join(dir, "signposts.db"));
    embedder ??= await createEmbedder({
      modelCacheDir: modelCacheRoot,
      allowRemoteModels: retrieval.allow_remote_models,
      localModelPath: retrieval.local_model_path,
      embeddingModel: EMBEDDING_MODEL,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it(
    "empty corpus returns an empty result, never padded",
    async () => {
      const embedding = await embedCandidate("Anything at all.");
      const neighbours = findNeighbours(db, "acme/platform", { claim: "Anything at all.", embedding }, 6);
      expect(neighbours).toEqual([]);
    },
    120_000,
  );

  it(
    "a near-duplicate claim retrieves the matching signpost as the top neighbour",
    async () => {
      // 05-retrieval.md's first acceptance criterion, as position rather than
      // membership (19-value-to-a-user.md item 14). The third signpost is the
      // deliberate near-miss: same subject, opposite claim. With the two
      // originals alone both came back for any query at k=6, so this assertion
      // held even if the ranking were reversed — which is what item 7 found it
      // to be.
      const withNearMiss: ActiveSignpost[] = [
        ...platformSignposts,
        {
          id: "staging-warehouse-writable",
          content_hash: "hash-3",
          claim: "The staging warehouse replica is writable; the nightly ETL truncates and reloads it.",
          evidence: "A fixture written into the replica disappeared overnight.",
        },
      ];
      for (const s of withNearMiss) {
        await insertSignpost(db, "acme/platform", s);
      }
      await rebuildIndex(db, { modelCacheDir: modelCacheRoot, retrieval, repo: "acme/platform", signposts: withNearMiss });

      const candidateClaim = "Staging DB is read-only, migrations must target dev.";
      const embedding = await embedCandidate(candidateClaim);
      const neighbours = findNeighbours(db, "acme/platform", { claim: candidateClaim, embedding }, 6);

      expect(neighbours.map((n) => n.id)[0]).toBe("staging-db-read-only");
    },
    120_000,
  );

  it(
    "repo isolation: another repo's signposts never appear as neighbours",
    async () => {
      await insertSignpost(db, "acme/platform", platformSignposts[0]!);
      await rebuildIndex(db, {
        modelCacheDir: modelCacheRoot,
        retrieval,
        repo: "acme/platform",
        signposts: [platformSignposts[0]!],
      });

      const otherSignpost: ActiveSignpost = {
        id: "other-repo-staging",
        content_hash: "hash-other",
        claim: "The staging database is read-only; run migrations against dev instead.",
        evidence: "Same claim, different repo.",
      };
      await insertSignpost(db, "acme/other", otherSignpost);
      await rebuildIndex(db, {
        modelCacheDir: modelCacheRoot,
        retrieval,
        repo: "acme/other",
        signposts: [otherSignpost],
      });

      const embedding = await embedCandidate(platformSignposts[0]!.claim);
      const neighbours = findNeighbours(db, "acme/platform", { claim: platformSignposts[0]!.claim, embedding }, 6);

      expect(neighbours.every((n) => n.id !== "other-repo-staging")).toBe(true);
    },
    120_000,
  );

  it(
    "active-only filter: a superseded signpost never appears as a neighbour",
    async () => {
      const superseded: ActiveSignpost = {
        id: "superseded-staging",
        content_hash: "hash-superseded",
        claim: "The staging database is read-only; run migrations against dev instead.",
        evidence: "Old note, since superseded.",
      };
      await insertSignpost(db, "acme/platform", superseded, { status: "superseded" });
      // rebuildIndex indexes whatever ActiveSignpost list it's given —
      // the caller (not exercised here) is responsible for only passing
      // active ones. Index it directly to prove findNeighbours' own
      // status filter (not the indexer) is what excludes it.
      await rebuildIndex(db, { modelCacheDir: modelCacheRoot, retrieval, repo: "acme/platform", signposts: [superseded] });

      const embedding = await embedCandidate(superseded.claim);
      const neighbours = findNeighbours(db, "acme/platform", { claim: superseded.claim, embedding }, 6);

      expect(neighbours).toEqual([]);
    },
    120_000,
  );

  // Below: an exact-text match ("close-match") always outranks a looser
  // paraphrase ("weak-match") on both the vector-KNN and FTS rankings —
  // giving close-match rank 1 and weak-match rank 2 in both lists, a real
  // (non-tied) RRF gap of ~0.0005, small enough for one path match
  // (weight 0.001, see PATH_OVERLAP_BOOST_WEIGHT) to close.
  const closeMatch: ActiveSignpost = {
    id: "close-match",
    content_hash: "hash-close",
    claim: "Run make build before make test.",
    evidence: "Tests failed against stale binaries.",
  };
  const weakMatch: ActiveSignpost = {
    id: "weak-match",
    content_hash: "hash-weak",
    claim: "You should run make build first, then make test afterwards.",
    evidence: "Tests failed against stale binaries.",
  };

  it(
    "path overlap promotes a lower-ranked neighbour above a higher-ranked one when the RRF gap is small enough to close",
    async () => {
      await insertSignpost(db, "acme/platform", closeMatch, {});
      await insertSignpost(db, "acme/platform", weakMatch, { paths: ["Makefile"] });
      await rebuildIndex(db, {
        modelCacheDir: modelCacheRoot,
        retrieval,
        repo: "acme/platform",
        signposts: [closeMatch, weakMatch],
      });

      const embedding = await embedCandidate(closeMatch.claim);
      const neighbours = findNeighbours(
        db,
        "acme/platform",
        { claim: closeMatch.claim, embedding, paths: ["Makefile"] },
        6,
      );

      expect(neighbours.length).toBeGreaterThanOrEqual(2);
      expect(neighbours[0]!.id).toBe("weak-match");
    },
    120_000,
  );

  it(
    "the promotion flips back when the path match moves to the higher-ranked doc instead",
    async () => {
      await insertSignpost(db, "acme/platform", closeMatch, { paths: ["Makefile"] });
      await insertSignpost(db, "acme/platform", weakMatch, {});
      await rebuildIndex(db, {
        modelCacheDir: modelCacheRoot,
        retrieval,
        repo: "acme/platform",
        signposts: [closeMatch, weakMatch],
      });

      const embedding = await embedCandidate(closeMatch.claim);
      const neighbours = findNeighbours(
        db,
        "acme/platform",
        { claim: closeMatch.claim, embedding, paths: ["Makefile"] },
        6,
      );

      expect(neighbours.length).toBeGreaterThanOrEqual(2);
      expect(neighbours[0]!.id).toBe("close-match");
    },
    120_000,
  );
});
