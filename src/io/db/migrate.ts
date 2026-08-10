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
 */
export function openDb(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);

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
