// The `sessions` table (12-wire-contracts.md): which transcripts a run has
// already processed, keyed by `${sessionId}:${contentHash}` — the pair, not
// the id, because a session that was resumed and grew is a different
// transcript with the same id and deserves to be processed again.
//
// Same db-first-param, prepared-statement style as the other modules here.

import type Database from "better-sqlite3";

/** Status recorded once a session's run finished. */
const STATUS_DONE = "done";

export interface SessionRecord {
  sessionId: string;
  contentHash: string;
  repo: string;
  repoRoot: string;
  lastActivityAt: string;
  tokenEstimate: number | null;
}

/** `${sessionId}:${contentHash}` for every session in `repo` a run has finished. */
export function processedKeys(db: Database.Database, repo: string): Set<string> {
  const rows = db
    .prepare(`SELECT session_id, content_hash FROM sessions WHERE repo = ? AND status = ?`)
    .all(repo, STATUS_DONE) as { session_id: string; content_hash: string }[];
  return new Set(rows.map((row) => `${row.session_id}:${row.content_hash}`));
}

/**
 * Records a finished session.
 *
 * Written when the run for that session completes, never when it halts: a
 * session waiting on a review has not been processed, and marking it so would
 * make the next run skip a thread nobody ever answered.
 */
export function markProcessed(db: Database.Database, record: SessionRecord): void {
  db.prepare(
    `INSERT INTO sessions
       (session_id, content_hash, repo, repo_root, last_activity_at, token_estimate, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (session_id, content_hash) DO UPDATE SET
       status = excluded.status,
       token_estimate = excluded.token_estimate,
       updated_at = excluded.updated_at`,
  ).run(
    record.sessionId,
    record.contentHash,
    record.repo,
    record.repoRoot,
    record.lastActivityAt,
    record.tokenEstimate,
    STATUS_DONE,
    new Date().toISOString(),
  );
}
