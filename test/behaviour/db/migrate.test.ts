// Behaviour test for the SQLite migrations mechanism — outside test/unit
// because the mutation-graded unit suite excludes src/io/ (see
// test/behaviour/transcript/read.test.ts for the same rationale). Root
// vitest.config.ts includes test/**/*.test.ts, so this still runs under
// `pnpm test`.

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../../../src/io/db/migrate.js";

function tableNames(db: Database.Database): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name);
}

function columnNames(db: Database.Database, table: string): string[] {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => (row as { name: string }).name);
}

describe("openDb", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "signposts-db-migrate-"));
    dbPath = path.join(dir, "signposts.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the full schema fresh: every table, expected columns, user_version at latest", () => {
    const db = openDb(dbPath);

    // signpost_vec (vec0) and signpost_fts (fts5) also register their own
    // shadow tables in sqlite_master — asserting a superset rather than an
    // exact list keeps this from being brittle to sqlite-vec/fts5 internals.
    expect(tableNames(db)).toEqual(
      expect.arrayContaining(["sessions", "signposts", "signpost_vec", "signpost_fts", "index_meta"]),
    );
    expect(columnNames(db, "sessions")).toEqual([
      "session_id",
      "content_hash",
      "repo",
      "repo_root",
      "last_activity_at",
      "token_estimate",
      "status",
      "skip_reason",
      "updated_at",
    ]);
    expect(columnNames(db, "signposts")).toEqual([
      "id",
      "repo",
      "claim",
      "category",
      "evidence",
      "scope_json",
      "confidence",
      "status",
      "provenance_json",
      "is_pending",
      "content_hash",
      "embedding_model",
      "embedding_dim",
      "pending_review",
    ]);
    expect(columnNames(db, "signpost_vec")).toEqual(["id", "repo", "signpost_id", "claim_embedding"]);
    expect(columnNames(db, "signpost_fts")).toEqual(["repo", "signpost_id", "claim", "evidence"]);
    expect(columnNames(db, "index_meta")).toEqual(["repo", "corpus_hash", "embedding_model", "updated_at"]);

    const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(user_version).toBe(10);

    db.close();
  });

  it("migrates an older schema forward without touching existing rows", () => {
    // Pre-seed a db at "version 1": sessions only, one real row, as if an
    // earlier build of this tool had created it.
    const seed = new Database(dbPath);
    seed.exec(`
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
    seed
      .prepare(
        `INSERT INTO sessions
          (session_id, content_hash, repo, repo_root, last_activity_at, token_estimate, status, skip_reason, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("s1", "hash1", "acme/platform", "/repo", "2026-08-01T00:00:00Z", 1234, "done", null, "2026-08-01T00:00:00Z");
    seed.exec("PRAGMA user_version = 1");
    seed.close();

    const db = openDb(dbPath);

    expect(tableNames(db)).toEqual(
      expect.arrayContaining(["sessions", "signposts", "signpost_vec", "signpost_fts", "index_meta"]),
    );
    const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(user_version).toBe(10);

    const row = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get("s1");
    expect(row).toEqual({
      session_id: "s1",
      content_hash: "hash1",
      repo: "acme/platform",
      repo_root: "/repo",
      last_activity_at: "2026-08-01T00:00:00Z",
      token_estimate: 1234,
      status: "done",
      skip_reason: null,
      updated_at: "2026-08-01T00:00:00Z",
    });

    db.close();
  });

  it("re-opening an already-current db is idempotent: no migrations re-run, data survives", () => {
    const first = openDb(dbPath);
    first
      .prepare(
        `INSERT INTO signposts
          (id, repo, claim, category, evidence, scope_json, confidence, status, provenance_json, is_pending, content_hash, embedding_model, embedding_dim)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "staging-db-read-only",
        "acme/platform",
        "The staging database is read-only.",
        "environment",
        "A migration run failed with a permissions error.",
        "{}",
        0.91,
        "active",
        "{}",
        0,
        "content-hash",
        "Xenova/all-MiniLM-L6-v2@abc",
        384,
      );
    first.close();

    const second = openDb(dbPath);

    const { user_version } = second.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(user_version).toBe(10);
    expect(tableNames(second)).toEqual(
      expect.arrayContaining(["sessions", "signposts", "signpost_vec", "signpost_fts", "index_meta"]),
    );

    const row = second.prepare("SELECT * FROM signposts WHERE id = ?").get("staging-db-read-only");
    expect(row).toMatchObject({ id: "staging-db-read-only", claim: "The staging database is read-only." });

    second.close();
  });

  it("migrating repo_state to nullable columns preserves an existing bootstrap_completed_at row", () => {
    // Pre-seed a db at "version 7": repo_state as it existed before the
    // consented_at migration (bootstrap_completed_at NOT NULL, no
    // consented_at column at all), with one real row. `signposts` and
    // `sessions` are seeded too, empty — a real v7 database has both, migration
    // 9 ALTERs the first and migration 10 rebuilds the second.
    const seed = new Database(dbPath);
    seed.exec(`
      CREATE TABLE repo_state (
        repo TEXT PRIMARY KEY,
        bootstrap_completed_at TEXT NOT NULL
      )
    `);
    seed.exec(`CREATE TABLE signposts (id TEXT NOT NULL, repo TEXT NOT NULL, PRIMARY KEY (repo, id))`);
    seed.exec(`
      CREATE TABLE sessions (
        session_id TEXT NOT NULL, content_hash TEXT NOT NULL, repo TEXT NOT NULL, repo_root TEXT NOT NULL,
        last_activity_at TEXT NOT NULL, token_estimate INTEGER, status TEXT NOT NULL, skip_reason TEXT,
        updated_at TEXT NOT NULL, PRIMARY KEY (session_id, content_hash)
      )
    `);
    seed
      .prepare(`INSERT INTO repo_state (repo, bootstrap_completed_at) VALUES (?, ?)`)
      .run("acme/platform", "2026-08-01T00:00:00Z");
    seed.exec("PRAGMA user_version = 7");
    seed.close();

    const db = openDb(dbPath);

    expect(columnNames(db, "repo_state")).toEqual(["repo", "bootstrap_completed_at", "consented_at"]);
    const row = db.prepare("SELECT * FROM repo_state WHERE repo = ?").get("acme/platform");
    expect(row).toEqual({
      repo: "acme/platform",
      bootstrap_completed_at: "2026-08-01T00:00:00Z",
      consented_at: null,
    });

    db.close();
  });

  it("making sessions.last_activity_at nullable keeps every recorded session", () => {
    // Seeded at "version 9": every table is current except `sessions`, whose
    // last_activity_at is still NOT NULL. Only the tables migration 10 touches
    // matter to it, so only that one is created.
    const seed = new Database(dbPath);
    seed.exec(`
      CREATE TABLE sessions (
        session_id TEXT NOT NULL, content_hash TEXT NOT NULL, repo TEXT NOT NULL, repo_root TEXT NOT NULL,
        last_activity_at TEXT NOT NULL, token_estimate INTEGER, status TEXT NOT NULL, skip_reason TEXT,
        updated_at TEXT NOT NULL, PRIMARY KEY (session_id, content_hash)
      )
    `);
    seed
      .prepare(`INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("s1", "h1", "acme/api", "/repo", "2026-09-01T09:00:00.000Z", 500, "done", null, "2026-09-02T00:00:00.000Z");
    seed.exec("PRAGMA user_version = 9");
    seed.close();

    const db = openDb(dbPath);

    expect(db.prepare("SELECT * FROM sessions").all()).toEqual([
      {
        session_id: "s1",
        content_hash: "h1",
        repo: "acme/api",
        repo_root: "/repo",
        last_activity_at: "2026-09-01T09:00:00.000Z",
        token_estimate: 500,
        status: "done",
        skip_reason: null,
        updated_at: "2026-09-02T00:00:00.000Z",
      },
    ]);
    // What the migration is for: a session whose activity is not known.
    db.prepare(`INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "s2", "h2", "acme/api", "/repo", null, null, "done", null, "2026-09-03T00:00:00.000Z",
    );
    expect(db.prepare("SELECT last_activity_at FROM sessions WHERE session_id = 's2'").get()).toEqual({
      last_activity_at: null,
    });

    db.close();
  });

  it("sqlite-vec is loaded on a reopen that runs no migrations, not just on the migrating path", () => {
    const first = openDb(dbPath);
    first.close();

    // dbPath is already at the latest version, so this second open takes the
    // fast path (no migrations run). signpost_vec is a vec0 virtual table —
    // querying it without the sqlite-vec extension loaded throws. This must
    // fail if `sqliteVec.load(db)` is moved to after the fast-path `return db`.
    const second = openDb(dbPath);
    expect(() => second.prepare("SELECT COUNT(*) FROM signpost_vec").get()).not.toThrow();

    second.close();
  });
});
