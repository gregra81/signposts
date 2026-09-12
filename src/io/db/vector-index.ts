// IO-level index rebuild: wires the pure core (corpus hash, reindex
// decision, claim normalisation) to the real embedder and the SQLite
// mirror. See 05-retrieval.md "Storage" / "Reindexing" and
// 16-build-plan.md's core/io split — everything decision-shaped lives in
// src/core/retrieval/, this file is glue plus the actual writes.

import type Database from "better-sqlite3";
import { EMBEDDING_DIM, EMBEDDING_MODEL } from "../../core/config/constants.ts";
import { computeCorpusHash } from "../../core/retrieval/corpus-hash.ts";
import { normalize } from "../../core/retrieval/normalize.ts";
import { shouldReindex } from "../../core/retrieval/reindex-decision.ts";
import { vectorToBlob } from "../../core/retrieval/vector-codec.ts";
import { createEmbedder } from "../embed/embedder.ts";

export interface ActiveSignpost {
  id: string;
  content_hash: string;
  claim: string;
  evidence: string;
}

export interface RebuildIndexOptions {
  /** Global model cache dir (paths.ts's modelCacheDir). */
  modelCacheDir: string;
  retrieval: {
    allow_remote_models: boolean;
    local_model_path: string | null;
  };
  /** Repo to scope the signpost_vec/signpost_fts rebuild to. */
  repo: string;
  /** Active signposts for this repo — the caller has already scope/status-filtered. */
  signposts: readonly ActiveSignpost[];
  /**
   * Called once, immediately before the embedder is built, and only when
   * there is something to rebuild.
   *
   * It is here rather than at the caller because this is the only place that
   * knows the answer. `shouldReindex` decides whether any of the expensive
   * work happens at all, and building the embedder is where a cold machine
   * spends ~23MB and the wall-clock time a user reads as a hang — so a caller
   * announcing it up front would announce a download that often does not
   * happen. `signpost index` prints from this; the worker passes nothing.
   */
  notify?: (() => void) | undefined;
}

interface IndexMetaRow {
  corpus_hash: string;
  embedding_model: string;
}

/**
 * Rebuilds signpost_vec / signpost_fts (and the embedding_model/dim mirror
 * on signposts) iff shouldReindex says so, in one transaction. Full rebuild
 * only — no incremental re-embed path.
 *
 * Returns whether it rebuilt, so a caller can tell a user it did the work
 * from one that found nothing to do.
 */
export async function rebuildIndex(db: Database.Database, options: RebuildIndexOptions): Promise<boolean> {
  const embeddingModel = EMBEDDING_MODEL;
  const currentCorpusHash = computeCorpusHash(options.signposts);

  const meta = db.prepare("SELECT corpus_hash, embedding_model FROM index_meta WHERE repo = ?").get(
    options.repo,
  ) as IndexMetaRow | undefined;

  const needsReindex = shouldReindex({
    indexExists: meta !== undefined,
    storedCorpusHash: meta?.corpus_hash ?? null,
    currentCorpusHash,
    storedEmbeddingModel: meta?.embedding_model ?? null,
    currentEmbeddingModel: embeddingModel,
  });

  if (!needsReindex) {
    return false;
  }

  options.notify?.();

  const embedder = await createEmbedder({
    modelCacheDir: options.modelCacheDir,
    allowRemoteModels: options.retrieval.allow_remote_models,
    localModelPath: options.retrieval.local_model_path,
    embeddingModel,
  });

  const normalizedClaims = options.signposts.map((signpost) => normalize(signpost.claim));
  const vectors = normalizedClaims.length > 0 ? await embedder.embed(normalizedClaims) : [];
  const embedded = options.signposts.map((signpost, i) => ({ signpost, vector: vectors[i]! }));

  const insertVec = db.prepare(
    "INSERT INTO signpost_vec (repo, id, signpost_id, claim_embedding) VALUES (?, ?, ?, ?)",
  );
  const insertFts = db.prepare("INSERT INTO signpost_fts (repo, signpost_id, claim, evidence) VALUES (?, ?, ?, ?)");
  const updateSignpost = db.prepare(
    "UPDATE signposts SET embedding_model = ?, embedding_dim = ? WHERE repo = ? AND id = ?",
  );
  const upsertMeta = db.prepare(`
    INSERT INTO index_meta (repo, corpus_hash, embedding_model, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (repo) DO UPDATE SET
      corpus_hash = excluded.corpus_hash,
      embedding_model = excluded.embedding_model,
      updated_at = excluded.updated_at
  `);

  // Scoped past the pending rows, for the same reason mirrorSignposts scopes
  // its delete (src/io/db/signposts.ts): a rebuild can fire in the middle of a
  // run — a pull request merging makes `shouldReindex` true at the next session
  // start, and `runWorker` reaches this through `runIndex` — and only the
  // merged corpus is reinserted below. An unscoped delete therefore took out
  // exactly the vector and FTS rows the mirror had just been taught to spare,
  // leaving the pending `signposts` rows alive and unretrievable: the same
  // reinforcement path going dead, one table further down.
  //
  // `clearPending` owns those rows (src/io/db/pending-index.ts). A proposal
  // that merged mid-run is no longer pending by the time we get here —
  // `mirrorSignposts` flipped its flag on the way in — so it is deleted and
  // reinserted with everything else, and no id is written twice.
  const deletePendingExcluded = (table: string): void => {
    db.prepare(
      `DELETE FROM ${table} WHERE repo = ? AND signpost_id NOT IN ` +
        "(SELECT id FROM signposts WHERE repo = ? AND is_pending = 1)",
    ).run(options.repo, options.repo);
  };

  const rebuild = db.transaction(() => {
    deletePendingExcluded("signpost_vec");
    deletePendingExcluded("signpost_fts");

    for (const { signpost, vector } of embedded) {
      insertVec.run(options.repo, `${options.repo}:${signpost.id}`, signpost.id, vectorToBlob(vector));
      insertFts.run(options.repo, signpost.id, signpost.claim, signpost.evidence);
      updateSignpost.run(embeddingModel, EMBEDDING_DIM, options.repo, signpost.id);
    }

    upsertMeta.run(options.repo, currentCorpusHash, embeddingModel, new Date().toISOString());
  });

  rebuild();
  return true;
}
