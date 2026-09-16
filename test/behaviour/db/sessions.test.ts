// The `sessions` table as the work queue's memory: what a run has judged, so
// no later run offers it again (12-wire-contracts.md; 19-value-to-a-user.md
// item 1). Real better-sqlite3 file, real migrations.

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../../../src/io/db/migrate.js";
import { markProcessed, markSkipped, processedKeys, type SessionRecord } from "../../../src/io/db/sessions.js";

const record = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  sessionId: "sess-1",
  contentHash: "hash-1",
  repo: "acme/api",
  repoRoot: "/repo",
  lastActivityAt: "2026-09-01T09:00:00.000Z",
  tokenEstimate: null,
  ...overrides,
});

describe("the sessions table", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "signposts-sessions-db-"));
    db = openDb(path.join(dir, "signposts.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("treats a finished session and a skipped one alike: neither is offered again", () => {
    markProcessed(db, record({ sessionId: "finished", tokenEstimate: 500 }));
    markSkipped(db, record({ sessionId: "unusable", contentHash: "hash-2" }));

    expect(processedKeys(db, "acme/api")).toEqual(new Set(["finished:hash-1", "unusable:hash-2"]));
  });

  it("records which of the two it was", () => {
    markProcessed(db, record({ sessionId: "finished" }));
    markSkipped(db, record({ sessionId: "unusable" }));

    const rows = db.prepare("SELECT session_id, status FROM sessions ORDER BY session_id").all();
    expect(rows).toEqual([
      { session_id: "finished", status: "done" },
      { session_id: "unusable", status: "skipped" },
    ]);
  });

  it("keeps each repo's sessions to that repo", () => {
    markSkipped(db, record({ repo: "acme/other" }));
    expect(processedKeys(db, "acme/api")).toEqual(new Set());
  });

  it("does not count a row in any other status as judged", () => {
    // 12-wire-contracts.md lists pending, running and failed on this column too.
    // A failed run is not a judgement: it may have been a disk or a bug.
    markProcessed(db, record());
    db.prepare("UPDATE sessions SET status = 'failed'").run();
    expect(processedKeys(db, "acme/api")).toEqual(new Set());
  });
});
