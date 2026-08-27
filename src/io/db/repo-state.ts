// IO for per-repo bootstrap state (repo_state table, migrate.ts) — the
// isBootstrap input the confidence gate (src/core/gate/gate.ts) needs,
// read/written here rather than by gate() itself. See
// src/io/db/neighbours.ts for the db-first-param/prepared-statement style
// this follows.

import type Database from "better-sqlite3";

// repo_state now also carries consented_at (R3), so a row can exist for a
// repo that has only consented and never bootstrapped, or vice versa —
// hasCompletedBootstrap/hasConsented check their own column's value, not
// merely whether a row exists.

/** True once `markBootstrapComplete` has run for this repo; false for a repo never seen before or mid-bootstrap. */
export function hasCompletedBootstrap(db: Database.Database, repo: string): boolean {
  const row = db.prepare(`SELECT bootstrap_completed_at FROM repo_state WHERE repo = ?`).get(repo) as
    | { bootstrap_completed_at: string | null }
    | undefined;
  return row?.bootstrap_completed_at != null;
}

/** Marks `repo`'s bootstrap run as complete so future calls route through the normal (non-bootstrap) gate. */
export function markBootstrapComplete(db: Database.Database, repo: string): void {
  db.prepare(
    `INSERT INTO repo_state (repo, bootstrap_completed_at)
     VALUES (?, ?)
     ON CONFLICT (repo) DO UPDATE SET bootstrap_completed_at = excluded.bootstrap_completed_at`,
  ).run(repo, new Date().toISOString());
}

/** True once `markConsented` has run for this repo — the "already-initialised" check for `signpost init`. */
export function hasConsented(db: Database.Database, repo: string): boolean {
  const row = db.prepare(`SELECT consented_at FROM repo_state WHERE repo = ?`).get(repo) as
    | { consented_at: string | null }
    | undefined;
  return row?.consented_at != null;
}

/** Persists `repo`'s first-run consent. Declining (R3) must never call this. */
export function markConsented(db: Database.Database, repo: string): void {
  db.prepare(
    `INSERT INTO repo_state (repo, consented_at)
     VALUES (?, ?)
     ON CONFLICT (repo) DO UPDATE SET consented_at = excluded.consented_at`,
  ).run(repo, new Date().toISOString());
}
