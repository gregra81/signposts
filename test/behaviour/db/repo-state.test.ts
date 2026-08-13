// Behaviour test for per-repo bootstrap-state IO (src/io/db/repo-state.ts)
// against a real better-sqlite3 file — same pattern as
// test/behaviour/db/migrate.test.ts.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../../../src/io/db/migrate.js";
import {
  hasCompletedBootstrap,
  hasConsented,
  markBootstrapComplete,
  markConsented,
} from "../../../src/io/db/repo-state.js";

describe("repo-state", () => {
  let dir: string;
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "signposts-db-repo-state-"));
    db = openDb(path.join(dir, "signposts.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a repo never seen before has not completed bootstrap", () => {
    expect(hasCompletedBootstrap(db, "acme/platform")).toBe(false);
  });

  it("markBootstrapComplete flips the flag for that repo only", () => {
    markBootstrapComplete(db, "acme/platform");

    expect(hasCompletedBootstrap(db, "acme/platform")).toBe(true);
    expect(hasCompletedBootstrap(db, "acme/other")).toBe(false);
  });

  it("marking complete twice is idempotent, not a duplicate-row error", () => {
    markBootstrapComplete(db, "acme/platform");
    markBootstrapComplete(db, "acme/platform");

    expect(hasCompletedBootstrap(db, "acme/platform")).toBe(true);
    const row = db.prepare("SELECT * FROM repo_state WHERE repo = ?").get("acme/platform") as {
      repo: string;
      bootstrap_completed_at: string;
    };
    expect(row.repo).toBe("acme/platform");
    expect(typeof row.bootstrap_completed_at).toBe("string");
  });

  it("markConsented alone does not flip hasCompletedBootstrap", () => {
    markConsented(db, "acme/platform");

    expect(hasCompletedBootstrap(db, "acme/platform")).toBe(false);
  });

  it("markBootstrapComplete alone does not flip hasConsented", () => {
    markBootstrapComplete(db, "acme/platform");

    expect(hasConsented(db, "acme/platform")).toBe(false);
  });
});
