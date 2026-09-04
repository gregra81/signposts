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
//   - **`is_pending = 1`.** These claims are proposed, not merged; the PR may
//     yet be rejected. The flag is what lets `classify` see that a neighbour
//     is not yet approved (12-wire-contracts.md's `signposts.is_pending`).
//   - **`index_meta` is not touched.** That row records the hash of the
//     *merged* corpus, and moving it here would tell the next `signpost
//     index` run that a rebuild it actually needs is already done.
//
// Rows are written with status 'active' because retrieval filters on it
// (./neighbours.ts) and a pending claim must be retrievable — pending is a
// review state, not a lifecycle state. The next full rebuild drops the vec/
// FTS rows for anything the merged corpus does not contain, which is the
// correct outcome for a proposal that was rejected.

import type Database from "better-sqlite3";
import { EMBEDDING_DIM, EMBEDDING_MODEL } from "../../core/config/constants.ts";
import { normalize } from "../../core/retrieval/normalize.ts";
import { vectorToBlob } from "../../core/retrieval/vector-codec.ts";
import { contentHashFor } from "../../core/signpost/content-hash.ts";
import type { Signpost } from "../../core/signpost/schema.ts";
import { createEmbedder } from "../embed/embedder.ts";

export interface IndexPendingOptions {
  /** Global model cache dir (paths.ts's modelCacheDir). */
  modelCacheDir: string;
  retrieval: {
    allow_remote_models: boolean;
    local_model_path: string | null;
  };
  repo: string;
  /** What the session proposed — src/core/graph/pending.ts's pendingSignposts. */
  signposts: readonly Signpost[];
}

/**
 * Indexes `signposts` for `repo` as pending, in one transaction: the mirror
 * row, the vector row and the FTS row, exactly as a rebuild would write them
 * apart from the pending flag.
 */
export async function indexPending(db: Database.Database, options: IndexPendingOptions): Promise<void> {
  if (options.signposts.length === 0) {
    return;
  }

  const embedder = await createEmbedder({
    modelCacheDir: options.modelCacheDir,
    allowRemoteModels: options.retrieval.allow_remote_models,
    localModelPath: options.retrieval.local_model_path,
    embeddingModel: EMBEDDING_MODEL,
  });

  const vectors = await embedder.embed(options.signposts.map((signpost) => normalize(signpost.claim)));
  const embedded = options.signposts.map((signpost, i) => ({ signpost, vector: vectors[i]! }));

  const upsertSignpost = db.prepare(`
    INSERT INTO signposts
      (id, repo, claim, category, evidence, scope_json, confidence, status, provenance_json, is_pending, content_hash, embedding_model, embedding_dim)
    VALUES (@id, @repo, @claim, @category, @evidence, @scope_json, @confidence, @status, @provenance_json, 1, @content_hash, @embedding_model, @embedding_dim)
    ON CONFLICT (repo, id) DO UPDATE SET
      claim = excluded.claim,
      category = excluded.category,
      evidence = excluded.evidence,
      scope_json = excluded.scope_json,
      confidence = excluded.confidence,
      status = excluded.status,
      provenance_json = excluded.provenance_json,
      is_pending = excluded.is_pending,
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
    for (const { signpost, vector } of embedded) {
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
