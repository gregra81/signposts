// IO for per-repo bootstrap state (repo_state table, migrate.ts) — the
// isBootstrap input the confidence gate (src/core/gate/gate.ts) needs,
// read/written here rather than by gate() itself. See
// src/io/db/neighbours.ts for the db-first-param/prepared-statement style
// this follows.

import type Database from "better-sqlite3";

/** True once `markBootstrapComplete` has run for this repo; false for a repo never seen before or mid-bootstrap. */
export function hasCompletedBootstrap(db: Database.Database, repo: string): boolean {
  const row = db.prepare(`SELECT bootstrap_completed_at FROM repo_state WHERE repo = ?`).get(repo);
  return row !== undefined;
}

/** Marks `repo`'s bootstrap run as complete so future calls route through the normal (non-bootstrap) gate. */
export function markBootstrapComplete(db: Database.Database, repo: string): void {
  db.prepare(
    `INSERT INTO repo_state (repo, bootstrap_completed_at)
     VALUES (?, ?)
     ON CONFLICT (repo) DO UPDATE SET bootstrap_completed_at = excluded.bootstrap_completed_at`,
  ).run(repo, new Date().toISOString());
}
