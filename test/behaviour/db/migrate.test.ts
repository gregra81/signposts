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

  it("creates the full schema fresh: both tables, expected columns, user_version at latest", () => {
    const db = openDb(dbPath);

    expect(tableNames(db)).toEqual(["sessions", "signposts"]);
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
    ]);

    const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(user_version).toBe(2);

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

    expect(tableNames(db)).toEqual(["sessions", "signposts"]);
    const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(user_version).toBe(2);

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
    expect(user_version).toBe(2);
    expect(tableNames(second)).toEqual(["sessions", "signposts"]);

    const row = second.prepare("SELECT * FROM signposts WHERE id = ?").get("staging-db-read-only");
    expect(row).toMatchObject({ id: "staging-db-read-only", claim: "The staging database is read-only." });

    second.close();
  });
});
