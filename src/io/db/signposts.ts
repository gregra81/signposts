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

import type Database from "better-sqlite3";
import type { Signpost } from "../../core/signpost/schema.ts";

export interface SignpostMirrorRow {
  signpost: Signpost;
  contentHash: string;
}

/**
 * Upserts every row in `rows` for `repo` in one transaction, and deletes
 * any existing row for `repo` whose id isn't in `rows` — a repo whose
 * signpost file was deleted since the last `index` run drops out rather
 * than lingering as a stale row. A row already present (same repo, id)
 * keeps its embedding_model/embedding_dim untouched.
 */
export function mirrorSignposts(db: Database.Database, repo: string, rows: readonly SignpostMirrorRow[]): void {
  const upsert = db.prepare(`
    INSERT INTO signposts
      (id, repo, claim, category, evidence, scope_json, confidence, status, provenance_json, is_pending, content_hash, embedding_model, embedding_dim)
    VALUES (@id, @repo, @claim, @category, @evidence, @scope_json, @confidence, @status, @provenance_json, 0, @content_hash, '', 0)
    ON CONFLICT (repo, id) DO UPDATE SET
      claim = excluded.claim,
      category = excluded.category,
      evidence = excluded.evidence,
      scope_json = excluded.scope_json,
      confidence = excluded.confidence,
      status = excluded.status,
      provenance_json = excluded.provenance_json,
      is_pending = excluded.is_pending,
      content_hash = excluded.content_hash
  `);

  const mirror = db.transaction((entries: readonly SignpostMirrorRow[]) => {
    const ids = entries.map(({ signpost }) => signpost.id);
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
