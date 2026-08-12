// Behaviour test for the index rebuild (R7) — real better-sqlite3 file,
// real sqlite-vec extension, real transformers.js embedder against the
// pinned model. No mocking, per 16-build-plan.md's "no test-double
// framework" rule. This downloads the ~23MB quantized model on first run
// in a given environment; a `modelCacheDir` shared across this file's
// tests keeps that to once.

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMBEDDING_DIM, EMBEDDING_MODEL } from "../../../src/core/config/constants.js";
import { computeCorpusHash } from "../../../src/core/retrieval/corpus-hash.js";
import { normalize } from "../../../src/core/retrieval/normalize.js";
import { createEmbedder } from "../../../src/io/embed/embedder.js";
import { openDb } from "../../../src/io/db/migrate.js";
import { rebuildIndex, type ActiveSignpost } from "../../../src/io/db/vector-index.js";

const modelCacheRoot = mkdtempSync(path.join(tmpdir(), "signposts-vector-index-model-"));
const retrieval = { allow_remote_models: true, local_model_path: null };

const signposts: ActiveSignpost[] = [
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
  {
    id: "make-build-required",
    content_hash: "hash-3",
    claim: "Run make build before make test; the test target does not build first.",
    evidence: "Tests failed against stale binaries twice in one session.",
  },
];

function vecRows(db: Database.Database): Array<{ id: string; vector: number[] }> {
  return (db.prepare("SELECT signpost_id, claim_embedding FROM signpost_vec ORDER BY signpost_id").all() as Array<{
    signpost_id: string;
    claim_embedding: Buffer;
  }>).map((row) => ({
    id: row.signpost_id,
    vector: Array.from(new Float32Array(row.claim_embedding.buffer, row.claim_embedding.byteOffset, EMBEDDING_DIM)),
  }));
}

function ftsRows(db: Database.Database): Array<{ id: string; claim: string; evidence: string }> {
  return (
    db.prepare("SELECT signpost_id, claim, evidence FROM signpost_fts ORDER BY signpost_id").all() as Array<{
      signpost_id: string;
      claim: string;
      evidence: string;
    }>
  ).map((row) => ({ id: row.signpost_id, claim: row.claim, evidence: row.evidence }));
}

describe("rebuildIndex", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "signposts-vector-index-db-"));
    db = openDb(path.join(dir, "signposts.db"));
    for (const s of signposts) {
      db.prepare(
        `INSERT INTO signposts
          (id, repo, claim, category, evidence, scope_json, confidence, status, provenance_json, is_pending, content_hash, embedding_model, embedding_dim)
         VALUES (?, 'acme/platform', ?, 'gotcha', ?, '{}', 0.9, 'active', '{}', 0, ?, '', 0)`,
      ).run(s.id, s.claim, s.evidence, s.content_hash);
    }
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  afterAll(() => {
    rmSync(modelCacheRoot, { recursive: true, force: true });
  });

  it(
    "A1/A2: rebuilding after clearing the tables reproduces identical vectors and FTS rows",
    async () => {
      await rebuildIndex(db, { modelCacheDir: modelCacheRoot, retrieval, repo: "acme/platform", signposts });

      const firstVecs = vecRows(db);
      const firstFts = ftsRows(db);
      expect(firstVecs).toHaveLength(signposts.length);
      expect(firstVecs[0]?.vector).toHaveLength(EMBEDDING_DIM);
      expect(firstFts).toHaveLength(signposts.length);

      const meta = db.prepare("SELECT corpus_hash, embedding_model FROM index_meta WHERE repo = ?").get(
        "acme/platform",
      ) as {
        corpus_hash: string;
        embedding_model: string;
      };
      expect(meta.embedding_model).toBe(EMBEDDING_MODEL);

      const mirrored = db.prepare("SELECT embedding_model, embedding_dim FROM signposts WHERE id = ?").get(
        signposts[0]!.id,
      ) as { embedding_model: string; embedding_dim: number };
      expect(mirrored).toEqual({ embedding_model: EMBEDDING_MODEL, embedding_dim: EMBEDDING_DIM });

      // Simulate the "index missing" trigger by clearing the derived tables
      // and the index_meta row directly (as if the index file had been
      // deleted), then rebuild. index_meta's presence is the "was an index
      // ever built" signal (vector-index.ts), so it has to go too, not just
      // the vec/fts rows.
      db.prepare("DELETE FROM signpost_vec").run();
      db.prepare("DELETE FROM signpost_fts").run();
      db.prepare("DELETE FROM index_meta").run();

      await rebuildIndex(db, { modelCacheDir: modelCacheRoot, retrieval, repo: "acme/platform", signposts });

      expect(vecRows(db)).toEqual(firstVecs);
      expect(ftsRows(db)).toEqual(firstFts);
    },
    120_000,
  );

  it(
    "A3: a pinned-revision change forces a full rebuild rather than a skip",
    async () => {
      // First, a real rebuild, so index_meta/signpost_vec reflect an
      // actually-populated index (not the "index missing" case).
      await rebuildIndex(db, { modelCacheDir: modelCacheRoot, retrieval, repo: "acme/platform", signposts });

      // Now stale only the model string in index_meta, leaving the corpus
      // hash matching the current signposts — so the *only* thing that
      // looks outdated is the model — and reset signposts.embedding_model
      // to a sentinel. A "skip" decision would leave that sentinel
      // untouched; only a real rebuild sets it to EMBEDDING_MODEL.
      const currentCorpusHash = computeCorpusHash(signposts);
      db.prepare(
        "UPDATE index_meta SET corpus_hash = ?, embedding_model = 'stale-model@old-revision' WHERE repo = ?",
      ).run(currentCorpusHash, "acme/platform");
      for (const s of signposts) {
        db.prepare("UPDATE signposts SET embedding_model = 'sentinel-untouched' WHERE id = ?").run(s.id);
      }

      await rebuildIndex(db, { modelCacheDir: modelCacheRoot, retrieval, repo: "acme/platform", signposts });

      for (const s of signposts) {
        const mirrored = db.prepare("SELECT embedding_model FROM signposts WHERE id = ?").get(s.id) as {
          embedding_model: string;
        };
        expect(mirrored.embedding_model).toBe(EMBEDDING_MODEL);
      }

      const after = db.prepare("SELECT embedding_model FROM index_meta WHERE repo = ?").get("acme/platform") as {
        embedding_model: string;
      };
      expect(after.embedding_model).toBe(EMBEDDING_MODEL);
    },
    120_000,
  );

  it(
    "unchanged content and model on a second call is a no-op (skip), not a rebuild",
    async () => {
      await rebuildIndex(db, { modelCacheDir: modelCacheRoot, retrieval, repo: "acme/platform", signposts });
      const before = db.prepare("SELECT updated_at FROM index_meta WHERE repo = ?").get("acme/platform") as {
        updated_at: string;
      };

      await rebuildIndex(db, { modelCacheDir: modelCacheRoot, retrieval, repo: "acme/platform", signposts });
      const after = db.prepare("SELECT updated_at FROM index_meta WHERE repo = ?").get("acme/platform") as {
        updated_at: string;
      };

      expect(after.updated_at).toBe(before.updated_at);
    },
    120_000,
  );

  it("embeds the normalised claim, not the raw claim", async () => {
    const raw: ActiveSignpost[] = [
      { id: "trailing-punct", content_hash: "h", claim: "  Some Claim!!!  ", evidence: "e" },
    ];
    db.prepare(
      `INSERT INTO signposts
        (id, repo, claim, category, evidence, scope_json, confidence, status, provenance_json, is_pending, content_hash, embedding_model, embedding_dim)
       VALUES ('trailing-punct', 'acme/platform', ?, 'gotcha', 'e', '{}', 0.9, 'active', '{}', 0, 'h', '', 0)`,
    ).run(raw[0]!.claim);

    await rebuildIndex(db, { modelCacheDir: modelCacheRoot, retrieval, repo: "acme/platform", signposts: raw });

    const embedder = await createEmbedder({
      modelCacheDir: modelCacheRoot,
      allowRemoteModels: retrieval.allow_remote_models,
      localModelPath: retrieval.local_model_path,
      embeddingModel: EMBEDDING_MODEL,
    });
    const [expected] = await embedder.embed([normalize(raw[0]!.claim)]);
    const actual = vecRows(db)[0]!.vector;
    expect(actual).toEqual(expected);
  }, 120_000);

  it(
    "R2: rebuilding one repo's index leaves another repo's signpost_vec/signpost_fts rows untouched",
    async () => {
      const otherRepo = "acme/other";
      const otherVector = Buffer.from(new Float32Array(EMBEDDING_DIM).fill(0.5).buffer);
      db.prepare("INSERT INTO signpost_vec (repo, id, signpost_id, claim_embedding) VALUES (?, ?, ?, ?)").run(
        otherRepo,
        `${otherRepo}:other-signpost`,
        "other-signpost",
        otherVector,
      );
      db.prepare("INSERT INTO signpost_fts (repo, signpost_id, claim, evidence) VALUES (?, ?, ?, ?)").run(
        otherRepo,
        "other-signpost",
        "other claim",
        "other evidence",
      );

      await rebuildIndex(db, { modelCacheDir: modelCacheRoot, retrieval, repo: "acme/platform", signposts });

      expect(db.prepare("SELECT signpost_id FROM signpost_vec WHERE repo = ?").all(otherRepo)).toEqual([
        { signpost_id: "other-signpost" },
      ]);
      expect(db.prepare("SELECT signpost_id FROM signpost_fts WHERE repo = ?").all(otherRepo)).toEqual([
        { signpost_id: "other-signpost" },
      ]);
      expect(
        db.prepare("SELECT signpost_id FROM signpost_vec WHERE repo = ?").all("acme/platform"),
      ).toHaveLength(signposts.length);
    },
    120_000,
  );

  it(
    "R4: index_meta is scoped per repo — a second repo with a matching corpus_hash still gets indexed, not skipped",
    async () => {
      const otherRepo = "acme/other";

      await rebuildIndex(db, { modelCacheDir: modelCacheRoot, retrieval, repo: "acme/platform", signposts });

      // Same ids/content_hashes as the first repo's signposts, so
      // computeCorpusHash (which hashes only id + content_hash, not repo)
      // produces the identical corpus_hash for this second, unrelated repo.
      // If index_meta were still keyed globally, the row that repo A's
      // rebuild just wrote would make this rebuild look like a no-op skip.
      await rebuildIndex(db, { modelCacheDir: modelCacheRoot, retrieval, repo: otherRepo, signposts });

      expect(db.prepare("SELECT signpost_id FROM signpost_vec WHERE repo = ?").all(otherRepo)).toHaveLength(
        signposts.length,
      );
      expect(db.prepare("SELECT signpost_id FROM signpost_fts WHERE repo = ?").all(otherRepo)).toHaveLength(
        signposts.length,
      );
      expect(
        db.prepare("SELECT signpost_id FROM signpost_vec WHERE repo = ?").all("acme/platform"),
      ).toHaveLength(signposts.length);
    },
    120_000,
  );
});
