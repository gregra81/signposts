// Versioned migrations for the per-repo SQLite mirror at DB_PATH (see
// src/core/config/paths.ts). Applied state lives in SQLite's own
// PRAGMA user_version — no separate bookkeeping table.
//
// Column-exact table definitions come from 12-wire-contracts.md. The
// LangGraph checkpointer owns and creates its own tables in a separate
// file at CHECKPOINT_PATH (see paths.ts) — nothing here needs to make
// room for them beyond leaving `migrations` open to future entries.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as sqliteVec from "sqlite-vec";
import { EMBEDDING_DIM } from "../../core/config/constants.js";

type MigrationStep = (db: Database.Database) => void;

// Position in this array is the migration's version (1-based) — adding the
// next migration is appending here, nothing else to keep in sync.
const migrations: MigrationStep[] = [
  (db) => {
    db.exec(`
      CREATE TABLE sessions (
        session_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        repo TEXT NOT NULL,
        repo_root TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        token_estimate INTEGER,
        status TEXT NOT NULL,
        skip_reason TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, content_hash)
      )
    `);
  },
  (db) => {
    db.exec(`
      CREATE TABLE signposts (
        id TEXT NOT NULL,
        repo TEXT NOT NULL,
        claim TEXT NOT NULL,
        category TEXT NOT NULL,
        evidence TEXT,
        scope_json TEXT NOT NULL,
        confidence REAL NOT NULL,
        status TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        is_pending INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT NOT NULL,
        embedding_model TEXT NOT NULL,
        embedding_dim INTEGER NOT NULL,
        PRIMARY KEY (repo, id)
      )
    `);
  },
  (db) => {
    db.exec(`
      CREATE VIRTUAL TABLE signpost_vec USING vec0(
        signpost_id TEXT PRIMARY KEY,
        claim_embedding FLOAT[${EMBEDDING_DIM}]
      )
    `);
    db.exec(`
      CREATE VIRTUAL TABLE signpost_fts USING fts5(
        signpost_id UNINDEXED, claim, evidence
      )
    `);
    db.exec(`
      CREATE TABLE index_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        corpus_hash TEXT NOT NULL,
        embedding_model TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  },
  // signpost_vec/signpost_fts are recreated (not ALTERed — vec0/fts5 virtual
  // tables don't support ALTER TABLE ADD COLUMN) with a `repo` column so
  // rebuildIndex can scope its DELETE/INSERT per repo instead of wiping
  // every repo's rows. vec0 only enforces a single global-unique PRIMARY
  // KEY, so uniqueness on (repo, signpost_id) is a composite `id` column
  // (`repo || ':' || signpost_id`); `repo` is also declared PARTITION KEY
  // so per-repo lookups don't scan the whole index. index_meta is cleared
  // so the next rebuildIndex call repopulates the now-empty tables instead
  // of seeing a matching corpus_hash and skipping.
  (db) => {
    db.exec(`DROP TABLE signpost_vec`);
    db.exec(`DROP TABLE signpost_fts`);
    db.exec(`
      CREATE VIRTUAL TABLE signpost_vec USING vec0(
        repo TEXT PARTITION KEY,
        id TEXT PRIMARY KEY,
        signpost_id TEXT,
        claim_embedding FLOAT[${EMBEDDING_DIM}]
      )
    `);
    db.exec(`
      CREATE VIRTUAL TABLE signpost_fts USING fts5(
        repo UNINDEXED, signpost_id UNINDEXED, claim, evidence
      )
    `);
    db.exec(`DELETE FROM index_meta`);
  },
  // index_meta's PK moves from a single global row (id = 1) to one row per
  // repo, matching signpost_vec/signpost_fts's repo scoping from the prior
  // migration — otherwise two repos sharing a DB could have one repo's
  // corpus_hash mask a stale index for another repo. Recreated rather than
  // ALTERed: SQLite can't change a column's PRIMARY KEY in place, and
  // existing rows don't need preserving since rebuildIndex repopulates
  // index_meta on its next call.
  (db) => {
    db.exec(`DROP TABLE index_meta`);
    db.exec(`
      CREATE TABLE index_meta (
        repo TEXT PRIMARY KEY,
        corpus_hash TEXT NOT NULL,
        embedding_model TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  },
];

function readUserVersion(db: Database.Database): number {
  const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return user_version;
}

/**
 * Opens (creating if absent) the SQLite file at `dbPath` and applies every
 * migration newer than the file's current `user_version`, in order, inside
 * one transaction. A file already at the latest version runs no migrations.
 *
 * Safe to call concurrently from multiple processes against the same
 * dbPath (this runs on users' laptops, so that happens routinely — e.g. two
 * invocations racing on first use before the file exists). The version
 * check below is an optimistic fast path: on the common case, where the db
 * is already current, it returns without taking any lock. Only when it
 * looks like migrations are needed do we open an IMMEDIATE transaction,
 * which blocks until it holds SQLite's write lock, and then re-read
 * `user_version` *inside* that transaction. If another process already won
 * the race and migrated first, that re-read sees the post-migration
 * version and this call's loop applies nothing. Without the re-read, two
 * processes that both saw version 0 before either committed would both try
 * to CREATE TABLE the same table and the second would crash.
 *
 * `sqlite-vec` is a runtime extension, not just a one-time schema step: the
 * vec0 module has to be loaded into *this* connection before `signpost_vec`
 * can be created or queried, so `sqliteVec.load(db)` runs on every call,
 * fresh file or existing, before the version check below.
 */
export function openDb(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  sqliteVec.load(db);

  if (readUserVersion(db) >= migrations.length) {
    return db;
  }

  // `.immediate` is a distinct callable variant of the transaction wrapper
  // (it issues `BEGIN IMMEDIATE` instead of plain `BEGIN`) — call it
  // directly, don't invoke `.immediate()` and call the result.
  db.transaction(() => {
    const currentVersion = readUserVersion(db);
    for (const migrate of migrations.slice(currentVersion)) {
      migrate(db);
    }
    if (currentVersion < migrations.length) {
      db.exec(`PRAGMA user_version = ${migrations.length}`);
    }
  }).immediate();

  return db;
}
