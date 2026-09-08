// IO write for the `signposts` table mirror (R4, `signpost index`): upserts
// one repo's rows to match the active signposts just parsed off disk, and
// deletes any row whose id is no longer present. No decision logic here —
// the caller (src/cli/commands/index.ts) has already parsed and filtered
// to ACTIVE_STATUS; this only serialises and writes.
//
// embedding_model/embedding_dim are set on INSERT only (a genuinely new
// row starts empty; rebuildIndex, src/io/db/vector-index.ts, fills them in
// once it embeds the claim) and deliberately excluded from the ON CONFLICT
// UPDATE — an unchanged second `index` run must not wipe the embedding
// columns for a row rebuildIndex decided not to re-embed.
//
// is_pending/pending_review are written on both paths, and both to 0: every
// row here was parsed off disk, so by definition it is merged. A signpost
// proposed during a run and merged before the run that would have cleared it
// (src/io/db/pending-index.ts) arrives here as an ordinary row, and leaving
// either flag set would have the gate treat recorded knowledge as something
// still waiting on a review.
//
// The delete takes the derived rows with it. signpost_vec/signpost_fts are
// keyed by signpost_id and nothing else prunes them, so a row dropped here
// without them leaves a vector pointing at a signpost that no longer exists —
// invisible, because findNeighbours joins back to `signposts` and discards the
// miss, and alive until the next full rebuild. That is the case for pending
// rows in particular: they are never on disk, so an `index` run during a run
// deletes every one of them.

import type Database from "better-sqlite3";
import { signpostSchema, type Signpost } from "../../core/signpost/schema.ts";

export interface SignpostMirrorRow {
  signpost: Signpost;
  contentHash: string;
}

/**
 * Upserts every row in `rows` for `repo` in one transaction, and deletes
 * any existing row for `repo` whose id isn't in `rows` — along with that id's
 * vector and FTS rows. A repo whose signpost file was deleted since the last
 * `index` run drops out rather than lingering as a stale row. A row already
 * present (same repo, id) keeps its embedding_model/embedding_dim untouched.
 */
export function mirrorSignposts(db: Database.Database, repo: string, rows: readonly SignpostMirrorRow[]): void {
  const upsert = db.prepare(`
    INSERT INTO signposts
      (id, repo, claim, category, evidence, scope_json, confidence, status, provenance_json, is_pending, pending_review, content_hash, embedding_model, embedding_dim)
    VALUES (@id, @repo, @claim, @category, @evidence, @scope_json, @confidence, @status, @provenance_json, 0, 0, @content_hash, '', 0)
    ON CONFLICT (repo, id) DO UPDATE SET
      claim = excluded.claim,
      category = excluded.category,
      evidence = excluded.evidence,
      scope_json = excluded.scope_json,
      confidence = excluded.confidence,
      status = excluded.status,
      provenance_json = excluded.provenance_json,
      is_pending = excluded.is_pending,
      pending_review = excluded.pending_review,
      content_hash = excluded.content_hash
  `);

  const mirror = db.transaction((entries: readonly SignpostMirrorRow[]) => {
    const ids = entries.map(({ signpost }) => signpost.id);
    const keep = ids.length === 0 ? "" : ` AND signpost_id NOT IN (${ids.map(() => "?").join(", ")})`;
    db.prepare(`DELETE FROM signpost_vec WHERE repo = ?${keep}`).run(repo, ...ids);
    db.prepare(`DELETE FROM signpost_fts WHERE repo = ?${keep}`).run(repo, ...ids);

    if (ids.length === 0) {
      db.prepare("DELETE FROM signposts WHERE repo = ?").run(repo);
    } else {
      const placeholders = ids.map(() => "?").join(", ");
      db.prepare(`DELETE FROM signposts WHERE repo = ? AND id NOT IN (${placeholders})`).run(repo, ...ids);
    }

    for (const { signpost, contentHash } of entries) {
      upsert.run({
        id: signpost.id,
        repo,
        claim: signpost.claim,
        category: signpost.category,
        evidence: signpost.evidence,
        scope_json: JSON.stringify(signpost.scope),
        confidence: signpost.confidence,
        status: signpost.status,
        provenance_json: JSON.stringify(signpost.provenance),
        content_hash: contentHash,
      });
    }
  });

  mirror(rows);
}

interface SignpostRow {
  id: string;
  claim: string;
  category: string;
  evidence: string | null;
  scope_json: string;
  confidence: number;
  status: string;
  provenance_json: string;
}

const SELECT_COLUMNS = "id, claim, category, evidence, scope_json, confidence, status, provenance_json";

/**
 * A mirror row back as a Signpost, parsed rather than cast: the row's JSON
 * columns were written by a previous version of this code, and the graph acts
 * on what comes back — `resolve_conflict` adjudicates against it.
 *
 * A row that no longer parses is dropped rather than thrown on, which is what
 * `signpost index` already does with a file that no longer parses. This runs
 * on the retrieval path — `neighbours.find`, once per candidate inside
 * `retrieve_neighbours` — so throwing took the whole run down over one stale
 * row, in every run in that repo, until someone worked out that `signpost
 * index` needed re-running. Both callers already treat an id they cannot
 * resolve as one that is not there.
 */
function toSignpost(row: SignpostRow): Signpost | undefined {
  const parsed = signpostSchema.safeParse({
    id: row.id,
    claim: row.claim,
    category: row.category,
    evidence: row.evidence ?? "",
    scope: safeJson(row.scope_json),
    confidence: row.confidence,
    status: row.status,
    provenance: safeJson(row.provenance_json),
  });
  return parsed.success ? parsed.data : undefined;
}

/** `JSON.parse` throws on a truncated column; the schema rejects the undefined. */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Every signpost id in use in `repo`, pending rows included — what slug generation must avoid. */
export function signpostIds(db: Database.Database, repo: string): Set<string> {
  const rows = db.prepare("SELECT id FROM signposts WHERE repo = ?").all(repo) as { id: string }[];
  return new Set(rows.map((row) => row.id));
}

export function signpostById(db: Database.Database, repo: string, id: string): Signpost | undefined {
  const row = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM signposts WHERE repo = ? AND id = ?`)
    .get(repo, id) as SignpostRow | undefined;
  return row === undefined ? undefined : toSignpost(row);
}

/** The named signposts, in the order the ids were given; unknown ids are skipped. */
export function signpostsByIds(db: Database.Database, repo: string, ids: readonly string[]): Signpost[] {
  const found = new Map(
    ids.length === 0
      ? []
      : (
          db
            .prepare(
              `SELECT ${SELECT_COLUMNS} FROM signposts WHERE repo = ? AND id IN (${ids.map(() => "?").join(", ")})`,
            )
            .all(repo, ...ids) as SignpostRow[]
        ).flatMap((row) => {
          const signpost = toSignpost(row);
          return signpost === undefined ? [] : [[row.id, signpost] as const];
        }),
  );
  return ids.flatMap((id) => {
    const signpost = found.get(id);
    return signpost === undefined ? [] : [signpost];
  });
}
