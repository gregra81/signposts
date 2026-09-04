// IO-level incremental reindex of one session's proposals, run between the
// sessions of a run (06-review-and-pr.md, "Reindex within a run, not only at
// commit"). The counterpart of ./vector-index.ts, which rebuilds the whole
// corpus and is driven by a corpus hash: this one adds a handful of rows and
// is driven by what the session just proposed.
//
// Three differences from a rebuild, all deliberate:
//
//   - **Additive.** Nothing is deleted except the rows for the ids being
//     written, so a re-run of the same session replaces its own proposals and
//     leaves every other repo row alone.
//   - **`is_pending = 1`, plus `pending_review`.** These claims are proposed,
//     not merged. `is_pending` says that much; `pending_review` says whether a
//     person is still holding this one, which is the half the gate acts on —
//     an operation against a proposal that may yet be rejected inherits its
//     review (src/core/gate/partition.ts), while one against a proposal
//     already committed to the branch does not.
//   - **`index_meta` is not touched.** That row records the hash of the
//     *merged* corpus, and moving it here would tell the next `signpost
//     index` run that a rebuild it actually needs is already done.
//
// A pending row must be retrievable, so `status` has to be 'active' —
// ./neighbours.ts hard-filters on it, and a row written any other way would be
// embedded and then silently never returned. Nothing enforces that here
// because nothing needs to: src/core/graph/pending.ts indexes only what an
// `add` proposed, and operations.ts mints those with ACTIVE_STATUS. The status
// on the signpost is written as it arrives rather than overridden, so a future
// caller passing something else fails visibly in its own tests instead of
// having a lie written for it.
//
// **Pending rows are run-scoped, and `clearPending` is what makes that true.**
// Nothing else removes them: a rejected proposal never changes the merged
// corpus hash, so `shouldReindex` stays false and rebuildIndex never fires —
// and even when it does fire it rewrites signpost_vec/signpost_fts and never
// touches the `signposts` row. Left alone, a proposal nobody accepted would
// stay active and retrievable in every future run of that repo, indistinguishable
// from approved knowledge. So a run clears the repo's pending rows before it
// starts: anything that merged in the meantime comes back through
// mirrorSignposts as an ordinary row, and anything that did not is gone.

import type Database from "better-sqlite3";
import { EMBEDDING_DIM, EMBEDDING_MODEL } from "../../core/config/constants.ts";
import { normalize } from "../../core/retrieval/normalize.ts";
import { vectorToBlob } from "../../core/retrieval/vector-codec.ts";
import { contentHashFor } from "../../core/signpost/content-hash.ts";
import { PENDING_STATES } from "../../core/contracts/graph.ts";
import type { PendingProposal } from "../../core/graph/pending.ts";
import type { Embedder } from "../embed/embedder.ts";

export interface IndexPendingOptions {
  /**
   * Built once per run by the caller and passed in on every call.
   * `createEmbedder` loads an ONNX pipeline each time it is called and caches
   * nothing, and this runs once per session boundary — constructing it here
   * would make an N-session run pay N model loads.
   */
  embedder: Embedder;
  repo: string;
  /** What the session proposed — src/core/graph/pending.ts's pendingProposals. */
  proposals: readonly PendingProposal[];
}

/**
 * Indexes `signposts` for `repo` as pending, in one transaction: the mirror
 * row, the vector row and the FTS row, exactly as a rebuild would write them
 * apart from the pending flag.
 *
 * Throws rather than writing if any proposal names an id a merged row already
 * holds. The upsert below keys on (repo, id) and replaces every column, so
 * such a write would overwrite recorded knowledge with a proposal and flag it
 * pending, and the next run's `clearPending` would then delete it. The row
 * itself would come back on the next `signpost index`, but its vector and FTS
 * rows would not: rebuildIndex is gated on the merged corpus hash, which none
 * of this changes, so retrieval for that signpost would stay dead until the
 * corpus or the embedding model moved. `generateSlug` already avoids ids in
 * `existingIds`, which makes this unreachable — and worth a loud failure
 * exactly because reaching it means that guarantee broke.
 */
export async function indexPending(db: Database.Database, options: IndexPendingOptions): Promise<void> {
  if (options.proposals.length === 0) {
    return;
  }

  const merged = mergedIdsAmong(db, options.repo, options.proposals);
  if (merged.length > 0) {
    throw new Error(
      `indexPending: ${merged.join(", ")} already exist as merged signposts in ${options.repo}. ` +
        "A proposal must never overwrite recorded knowledge; the slug generator is supposed to " +
        "make this impossible.",
    );
  }

  const vectors = await options.embedder.embed(
    options.proposals.map(({ signpost }) => normalize(signpost.claim)),
  );
  const embedded = options.proposals.map((proposal, i) => ({ ...proposal, vector: vectors[i]! }));

  const upsertSignpost = db.prepare(`
    INSERT INTO signposts
      (id, repo, claim, category, evidence, scope_json, confidence, status, provenance_json, is_pending, pending_review, content_hash, embedding_model, embedding_dim)
    VALUES (@id, @repo, @claim, @category, @evidence, @scope_json, @confidence, @status, @provenance_json, 1, @pending_review, @content_hash, @embedding_model, @embedding_dim)
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
      content_hash = excluded.content_hash,
      embedding_model = excluded.embedding_model,
      embedding_dim = excluded.embedding_dim
  `);
  const deleteVec = db.prepare("DELETE FROM signpost_vec WHERE repo = ? AND signpost_id = ?");
  const deleteFts = db.prepare("DELETE FROM signpost_fts WHERE repo = ? AND signpost_id = ?");
  const insertVec = db.prepare(
    "INSERT INTO signpost_vec (repo, id, signpost_id, claim_embedding) VALUES (?, ?, ?, ?)",
  );
  const insertFts = db.prepare("INSERT INTO signpost_fts (repo, signpost_id, claim, evidence) VALUES (?, ?, ?, ?)");

  const write = db.transaction(() => {
    for (const { signpost, state, vector } of embedded) {
      upsertSignpost.run({
        id: signpost.id,
        repo: options.repo,
        claim: signpost.claim,
        category: signpost.category,
        evidence: signpost.evidence,
        scope_json: JSON.stringify(signpost.scope),
        confidence: signpost.confidence,
        status: signpost.status,
        provenance_json: JSON.stringify(signpost.provenance),
        pending_review: state === PENDING_STATES.awaiting_review ? 1 : 0,
        content_hash: contentHashFor(signpost),
        embedding_model: EMBEDDING_MODEL,
        embedding_dim: EMBEDDING_DIM,
      });

      // Deleted first rather than upserted: signpost_vec is a vec0 virtual
      // table, which has no ON CONFLICT, and re-proposing the same id must
      // not leave two vectors pointing at one signpost.
      deleteVec.run(options.repo, signpost.id);
      deleteFts.run(options.repo, signpost.id);
      insertVec.run(options.repo, `${options.repo}:${signpost.id}`, signpost.id, vectorToBlob(vector));
      insertFts.run(options.repo, signpost.id, signpost.claim, signpost.evidence);
    }
  });

  write();
}

/** Which of these proposal ids are already recorded (merged) rows in `repo`. */
function mergedIdsAmong(
  db: Database.Database,
  repo: string,
  proposals: readonly PendingProposal[],
): string[] {
  const ids = proposals.map(({ signpost }) => signpost.id);
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT id FROM signposts WHERE repo = ? AND is_pending = 0 AND id IN (${placeholders}) ORDER BY id`,
    )
    .all(repo, ...ids) as { id: string }[];
  return rows.map((row) => row.id);
}

/**
 * Drops every pending row for `repo`, and the vector and FTS rows that went
 * with them. Called at the start of a run — see the module comment on why
 * nothing else would ever remove them.
 */
export function clearPending(db: Database.Database, repo: string): void {
  const clear = db.transaction(() => {
    const ids = (
      db.prepare("SELECT id FROM signposts WHERE repo = ? AND is_pending = 1").all(repo) as { id: string }[]
    ).map((row) => row.id);

    for (const id of ids) {
      db.prepare("DELETE FROM signpost_vec WHERE repo = ? AND signpost_id = ?").run(repo, id);
      db.prepare("DELETE FROM signpost_fts WHERE repo = ? AND signpost_id = ?").run(repo, id);
    }
    db.prepare("DELETE FROM signposts WHERE repo = ? AND is_pending = 1").run(repo);
  });

  clear();
}
