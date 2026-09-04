// Behaviour test for the incremental pending reindex — real better-sqlite3
// file, real sqlite-vec extension, real FTS5, real transformers.js embedder
// against the pinned model, same setup and rationale as ./neighbours.test.ts.
//
// The question it answers is the one 06-review-and-pr.md raises: after
// session N's proposals are indexed, does session N+1 retrieve them, and does
// it retrieve them marked pending rather than as settled knowledge?

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMBEDDING_DIM, EMBEDDING_MODEL } from "../../../src/core/config/constants.js";
import { normalize } from "../../../src/core/retrieval/normalize.js";
import { contentHashFor } from "../../../src/core/signpost/content-hash.js";
import type { Signpost } from "../../../src/core/signpost/schema.js";
import { createEmbedder, type Embedder } from "../../../src/io/embed/embedder.js";
import { openDb } from "../../../src/io/db/migrate.js";
import {
  clearPending,
  indexPending,
  type IndexPendingOptions,
} from "../../../src/io/db/pending-index.js";
import { findNeighbours } from "../../../src/io/db/neighbours.js";
import { rebuildIndex } from "../../../src/io/db/vector-index.js";
import { testLocalModelPath, testModelCache } from "../../support/model-cache.js";

const modelCacheRoot = testModelCache();
const retrieval = { allow_remote_models: false, local_model_path: testLocalModelPath() };
const REPO = "acme/platform";

function proposed(overrides: Partial<Signpost> = {}): Signpost {
  return {
    id: "staging-db-read-only",
    claim: "The staging database is read-only; run migrations against dev instead.",
    category: "environment",
    scope: { repo: REPO },
    evidence: "A migration run against staging failed with a permissions error.",
    confidence: 0.9,
    provenance: {
      session_ids: ["sess-1"],
      authors: ["dev@acme.example"],
      first_seen: "2026-08-27",
      last_reinforced: "2026-08-27",
    },
    status: "active",
    ...overrides,
  };
}

let embedder: Embedder;

async function embedCandidate(claim: string): Promise<number[]> {
  const [vector] = await embedder.embed([normalize(claim)]);
  return vector!;
}

describe("indexPending", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "signposts-pending-index-db-"));
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
    "a proposal from one session is retrievable, and marked pending, in the next",
    async () => {
      const signpost = proposed();
      await indexPending(db, { embedder, repo: REPO, proposals: [{ signpost, state: "in_pr" }] });

      const claim = "Staging DB is read-only, migrations must target dev.";
      const neighbours = findNeighbours(db, REPO, { claim, embedding: await embedCandidate(claim) }, 6);

      expect(neighbours).toHaveLength(1);
      expect(neighbours[0]).toMatchObject({ id: signpost.id, pending: "in_pr" });
    },
    120_000,
  );

  it(
    "writes the mirror row a rebuild would, apart from the pending flag",
    async () => {
      const signpost = proposed();
      await indexPending(db, { embedder, repo: REPO, proposals: [{ signpost, state: "in_pr" }] });

      const row = db.prepare("SELECT * FROM signposts WHERE repo = ? AND id = ?").get(REPO, signpost.id) as {
        is_pending: number;
        status: string;
        content_hash: string;
        embedding_model: string;
        embedding_dim: number;
      };

      expect(row).toMatchObject({
        is_pending: 1,
        status: "active",
        content_hash: contentHashFor(signpost),
        embedding_model: EMBEDDING_MODEL,
        embedding_dim: EMBEDDING_DIM,
      });
    },
    120_000,
  );

  // The half the gate reads: a proposal a person is still holding is written
  // as awaiting_review and comes back out of retrieval that way.
  it(
    "records which proposals a person is still holding",
    async () => {
      await indexPending(db, {
        embedder,
        repo: REPO,
        proposals: [
          { signpost: proposed(), state: "awaiting_review" },
          { signpost: proposed({ id: "etl-window", claim: "The ETL job runs at 03:00 UTC." }), state: "in_pr" },
        ],
      });

      const rows = db
        .prepare("SELECT id, pending_review FROM signposts WHERE repo = ? ORDER BY id")
        .all(REPO) as { id: string; pending_review: number }[];
      expect(rows).toEqual([
        { id: "etl-window", pending_review: 0 },
        { id: "staging-db-read-only", pending_review: 1 },
      ]);

      const claim = "Staging DB is read-only, migrations must target dev.";
      const [nearest] = findNeighbours(db, REPO, { claim, embedding: await embedCandidate(claim) }, 1);
      expect(nearest).toMatchObject({ id: "staging-db-read-only", pending: "awaiting_review" });
    },
    120_000,
  );

  it(
    "re-proposing the same signpost leaves one vector, not two",
    async () => {
      const options: IndexPendingOptions = {
        embedder,
        repo: REPO,
        proposals: [{ signpost: proposed(), state: "in_pr" }],
      };
      await indexPending(db, options);
      await indexPending(db, options);

      const count = db
        .prepare("SELECT count(*) AS n FROM signpost_vec WHERE repo = ? AND signpost_id = ?")
        .get(REPO, proposed().id) as { n: number };
      expect(count.n).toBe(1);
    },
    120_000,
  );

  // index_meta is the merged corpus's hash. Moving it here would tell the
  // next `signpost index` run that a rebuild it actually needs is done.
  it(
    "leaves index_meta alone",
    async () => {
      await rebuildIndex(db, {
        modelCacheDir: modelCacheRoot,
        retrieval,
        repo: REPO,
        signposts: [{ id: "prisma-schema-path", content_hash: "hash-2", claim: "The Prisma schema lives at prisma/schema.prisma.", evidence: "A generate step looked in the wrong directory." }],
      });
      const before = db.prepare("SELECT corpus_hash FROM index_meta WHERE repo = ?").get(REPO);

      await indexPending(db, { embedder, repo: REPO, proposals: [{ signpost: proposed(), state: "in_pr" }] });

      expect(db.prepare("SELECT corpus_hash FROM index_meta WHERE repo = ?").get(REPO)).toEqual(before);
    },
    120_000,
  );

  // The upsert keys on (repo, id) and replaces every column, so a collision
  // would overwrite recorded knowledge with a proposal and flag it pending —
  // and the next run's clearPending would then delete it. generateSlug makes
  // this unreachable; reaching it means that guarantee broke.
  it(
    "refuses to overwrite a merged signpost with a proposal of the same id",
    async () => {
      db.prepare(
        `INSERT INTO signposts
          (id, repo, claim, category, evidence, scope_json, confidence, status, provenance_json, is_pending, pending_review, content_hash, embedding_model, embedding_dim)
         VALUES (?, ?, 'The recorded claim.', 'gotcha', 'From the repo.', '{}', 0.9, 'active', '{}', 0, 0, 'hash-1', '', 0)`,
      ).run(proposed().id, REPO);

      await expect(
        indexPending(db, { embedder, repo: REPO, proposals: [{ signpost: proposed(), state: "in_pr" }] }),
      ).rejects.toThrow(/already exist as merged signposts/);

      const row = db.prepare("SELECT claim FROM signposts WHERE repo = ? AND id = ?").get(REPO, proposed().id) as {
        claim: string;
      };
      expect(row.claim).toBe("The recorded claim.");
    },
    120_000,
  );

  it(
    "a session that proposed nothing writes nothing",
    async () => {
      await indexPending(db, { embedder, repo: REPO, proposals: [] });

      const count = db.prepare("SELECT count(*) AS n FROM signposts").get() as { n: number };
      expect(count.n).toBe(0);
    },
    120_000,
  );
});

describe("clearPending", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "signposts-clear-pending-db-"));
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

  // A proposal nobody accepted changes neither the merged corpus nor its hash,
  // so no rebuild is ever triggered to remove it. This is the only thing that
  // does, and a run calls it before it starts.
  it(
    "removes a proposal nobody merged, along with its vector and FTS rows",
    async () => {
      await indexPending(db, { embedder, repo: REPO, proposals: [{ signpost: proposed(), state: "in_pr" }] });

      clearPending(db, REPO);

      const claim = "Staging DB is read-only, migrations must target dev.";
      expect(findNeighbours(db, REPO, { claim, embedding: await embedCandidate(claim) }, 6)).toEqual([]);
      for (const table of ["signposts", "signpost_vec", "signpost_fts"]) {
        const count = db.prepare(`SELECT count(*) AS n FROM ${table} WHERE repo = ?`).get(REPO) as { n: number };
        expect(count.n).toBe(0);
      }
    },
    120_000,
  );

  it(
    "leaves merged rows alone",
    async () => {
      db.prepare(
        `INSERT INTO signposts
          (id, repo, claim, category, evidence, scope_json, confidence, status, provenance_json, is_pending, content_hash, embedding_model, embedding_dim)
         VALUES ('prisma-schema-path', ?, 'The Prisma schema lives at prisma/schema.prisma.', 'gotcha', '', '{}', 0.9, 'active', '{}', 0, 'hash-2', '', 0)`,
      ).run(REPO);
      await indexPending(db, { embedder, repo: REPO, proposals: [{ signpost: proposed(), state: "in_pr" }] });

      clearPending(db, REPO);

      const ids = (db.prepare("SELECT id FROM signposts WHERE repo = ?").all(REPO) as { id: string }[]).map(
        (row) => row.id,
      );
      expect(ids).toEqual(["prisma-schema-path"]);
    },
    120_000,
  );

  it(
    "leaves another repo's pending rows alone",
    async () => {
      await indexPending(db, { embedder, repo: REPO, proposals: [{ signpost: proposed(), state: "in_pr" }] });
      await indexPending(db, { embedder, repo: "acme/api", proposals: [{ signpost: proposed(), state: "in_pr" }] });

      clearPending(db, REPO);

      const count = db.prepare("SELECT count(*) AS n FROM signposts WHERE repo = ?").get("acme/api") as {
        n: number;
      };
      expect(count.n).toBe(1);
    },
    120_000,
  );
});
