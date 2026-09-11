// Behaviour test for the `signpost index` mirror write, against a real
// database — specifically its three jobs at the boundary with the within-run
// pending index (../../../src/io/db/pending-index.ts): a row parsed off disk
// is merged by definition, a merged row that is no longer on disk takes its
// derived rows with it, and a *pending* row survives both, because it is never
// on disk and `clearPending` is what owns it.

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
import { rebuildIndex } from "../../../src/io/db/vector-index.js";
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

/** Every vector row's signpost, for asserting what survived a mirror. */
function vectorIdsFrom(db: Database.Database): string[] {
  return (
    db.prepare("SELECT signpost_id FROM signpost_vec WHERE repo = ?").all(REPO) as {
      signpost_id: string;
    }[]
  ).map((row) => row.signpost_id);
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

  /** A merged corpus, mirrored and embedded — what `signpost index` leaves. */
  async function mirrorWithVectors(...signposts: Signpost[]): Promise<void> {
    mirror(db, signposts);
    await rebuildIndex(db, {
      modelCacheDir: modelCacheRoot,
      retrieval,
      repo: REPO,
      signposts: signposts.map((entry) => ({
        id: entry.id,
        content_hash: contentHashFor(entry),
        claim: entry.claim,
        evidence: entry.evidence,
      })),
    });
  }

  const vectorIds = () => vectorIdsFrom(db);

  // A signpost whose file was deleted since the last run drops out, and its
  // vector and FTS rows have to go with it: nothing else prunes them, and one
  // left behind points at a signpost that no longer exists.
  it(
    "takes a dropped row's vector and FTS rows with it",
    async () => {
      await mirrorWithVectors(signpost());
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
      await mirrorWithVectors(kept, dropped);

      mirror(db, [kept]);

      expect(vectorIds()).toEqual([kept.id]);
    },
    120_000,
  );

  // The race this closes: `runWorker` reaches `mirrorSignposts` through
  // `runIndex` at every session start, and `run`/`resume` take no lock it
  // respects. Scoping the delete by "not in the corpus" therefore deleted the
  // proposals of a run in flight — a pending row is never on disk — so a
  // session started midway through a multi-session run silently took out what
  // the earlier sessions had proposed, and the reinforcement path in
  // 06-review-and-pr.md went dead for the rest of it.
  it(
    "spares a run's pending rows, which are never on disk and are not its to delete",
    async () => {
      const merged = signpost();
      const proposed = signpost({ id: "etl-window", claim: "The ETL job runs at 03:00 UTC." });
      await mirrorWithVectors(merged);
      await indexPending(db, { embedder, repo: REPO, proposals: [{ signpost: proposed, state: "in_pr" }] });

      // A session start mid-run: the corpus on disk holds only the merged one.
      mirror(db, [merged]);

      const rows = db
        .prepare("SELECT id, is_pending FROM signposts WHERE repo = ? ORDER BY id")
        .all(REPO) as { id: string; is_pending: number }[];
      expect(rows).toEqual([
        { id: proposed.id, is_pending: 1 },
        { id: merged.id, is_pending: 0 },
      ]);
      // And it stays retrievable: findNeighbours joins back through these.
      expect(vectorIds().sort()).toEqual([merged.id, proposed.id].sort());
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
