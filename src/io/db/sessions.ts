// The `sessions` table (12-wire-contracts.md): which transcripts a run has
// already processed, keyed by `${sessionId}:${contentHash}` — the pair, not
// the id, because a session that was resumed and grew is a different
// transcript with the same id and deserves to be processed again.
//
// Same db-first-param, prepared-statement style as the other modules here.

import type Database from "better-sqlite3";

/** Status recorded once a session's run finished. */
const STATUS_DONE = "done";

/**
 * Status recorded for a transcript that can never be extracted — empty, all
 * sidechain, or one a redactor fails on (../../core/errors/unusable-transcript.ts).
 * 12-wire-contracts.md has listed it on this column since the schema was
 * drafted; nothing wrote it, so those sessions were never recorded at all.
 */
const STATUS_SKIPPED = "skipped";

export interface SessionRecord {
  sessionId: string;
  contentHash: string;
  repo: string;
  repoRoot: string;
  /** ISO timestamp, or null when the halted transcript has since moved on. */
  lastActivityAt: string | null;
  tokenEstimate: number | null;
}

/**
 * `${sessionId}:${contentHash}` for every session in `repo` a run has judged:
 * finished, or skipped as unusable. Both mean "do not offer this again".
 */
export function processedKeys(db: Database.Database, repo: string): Set<string> {
  const rows = db
    .prepare(`SELECT session_id, content_hash FROM sessions WHERE repo = ? AND status IN (?, ?)`)
    .all(repo, STATUS_DONE, STATUS_SKIPPED) as { session_id: string; content_hash: string }[];
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
  writeSession(db, record, STATUS_DONE);
}

/**
 * Records a session skipped as unusable. Same row, same key, different status,
 * and the reason in `skip_reason` — the only record of why a session will
 * never be offered again, once the stdout line that said so has scrolled away.
 */
export function markSkipped(db: Database.Database, record: SessionRecord, reason: string): void {
  writeSession(db, record, STATUS_SKIPPED, reason);
}

function writeSession(
  db: Database.Database,
  record: SessionRecord,
  status: string,
  skipReason: string | null = null,
): void {
  db.prepare(
    `INSERT INTO sessions
       (session_id, content_hash, repo, repo_root, last_activity_at, token_estimate, status, skip_reason, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (session_id, content_hash) DO UPDATE SET
       status = excluded.status,
       token_estimate = excluded.token_estimate,
       skip_reason = excluded.skip_reason,
       updated_at = excluded.updated_at`,
  ).run(
    record.sessionId,
    record.contentHash,
    record.repo,
    record.repoRoot,
    record.lastActivityAt,
    record.tokenEstimate,
    status,
    skipReason,
    new Date().toISOString(),
  );
}
