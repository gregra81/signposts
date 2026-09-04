// Behaviour test for the `signpost index` mirror write, against a real
// database — specifically its two jobs at the boundary with the within-run
// pending index (../../../src/io/db/pending-index.ts): a row parsed off disk
// is merged by definition, and a row that is no longer on disk takes its
// derived rows with it.

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMBEDDING_MODEL } from "../../../src/core/config/constants.js";
import { contentHashFor } from "../../../src/core/signpost/content-hash.js";
import type { Signpost } from "../../../src/core/signpost/schema.js";
import { createEmbedder, type Embedder } from "../../../src/io/embed/embedder.js";
import { openDb } from "../../../src/io/db/migrate.js";
import { indexPending } from "../../../src/io/db/pending-index.js";
import { mirrorSignposts } from "../../../src/io/db/signposts.js";
import { testLocalModelPath, testModelCache } from "../../support/model-cache.js";

const modelCacheRoot = testModelCache();
const retrieval = { allow_remote_models: false, local_model_path: testLocalModelPath() };
const REPO = "acme/platform";

function signpost(overrides: Partial<Signpost> = {}): Signpost {
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

function mirror(db: Database.Database, signposts: readonly Signpost[]): void {
  mirrorSignposts(
    db,
    REPO,
    signposts.map((entry) => ({ signpost: entry, contentHash: contentHashFor(entry) })),
  );
}

function counts(db: Database.Database): { vec: number; fts: number; rows: number } {
  const count = (table: string) =>
    (db.prepare(`SELECT count(*) AS n FROM ${table} WHERE repo = ?`).get(REPO) as { n: number }).n;
  return { vec: count("signpost_vec"), fts: count("signpost_fts"), rows: count("signposts") };
}

let embedder: Embedder;

describe("mirrorSignposts", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "signposts-mirror-db-"));
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

  // A proposal is not on disk, so an `index` run during a run drops it. Its
  // vector and FTS rows have to go with it: nothing else prunes them, and one
  // left behind points at a signpost that no longer exists.
  it(
    "takes a dropped row's vector and FTS rows with it",
    async () => {
      await indexPending(db, { embedder, repo: REPO, proposals: [{ signpost: signpost(), state: "in_pr" }] });
      expect(counts(db)).toEqual({ vec: 1, fts: 1, rows: 1 });

      mirror(db, []);

      expect(counts(db)).toEqual({ vec: 0, fts: 0, rows: 0 });
    },
    120_000,
  );

  it(
    "keeps the derived rows of a signpost that is still on disk",
    async () => {
      const kept = signpost();
      const dropped = signpost({ id: "etl-window", claim: "The ETL job runs at 03:00 UTC." });
      await indexPending(db, {
        embedder,
        repo: REPO,
        proposals: [
          { signpost: kept, state: "in_pr" },
          { signpost: dropped, state: "in_pr" },
        ],
      });

      mirror(db, [kept]);

      const vectors = db
        .prepare("SELECT signpost_id FROM signpost_vec WHERE repo = ?")
        .all(REPO) as { signpost_id: string }[];
      expect(vectors.map((row) => row.signpost_id)).toEqual([kept.id]);
    },
    120_000,
  );

  // The proposal merged before the run that would have cleared it. Both flags
  // have to come off, or the gate keeps treating recorded knowledge as
  // something a person is still holding.
  it(
    "clears both pending flags on a proposal that has since merged",
    async () => {
      await indexPending(db, {
        embedder,
        repo: REPO,
        proposals: [{ signpost: signpost(), state: "awaiting_review" }],
      });

      mirror(db, [signpost()]);

      const row = db
        .prepare("SELECT is_pending, pending_review FROM signposts WHERE repo = ? AND id = ?")
        .get(REPO, signpost().id) as { is_pending: number; pending_review: number };
      expect(row).toEqual({ is_pending: 0, pending_review: 0 });
    },
    120_000,
  );
});
