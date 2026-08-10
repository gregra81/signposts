// IO-level index rebuild: wires the pure core (corpus hash, reindex
// decision, claim normalisation) to the real embedder and the SQLite
// mirror. See 05-retrieval.md "Storage" / "Reindexing" and
// 16-build-plan.md's core/io split — everything decision-shaped lives in
// src/core/retrieval/, this file is glue plus the actual writes.

import type Database from "better-sqlite3";
import { EMBEDDING_DIM, EMBEDDING_MODEL } from "../../core/config/constants.js";
import { computeCorpusHash } from "../../core/retrieval/corpus-hash.js";
import { normalize } from "../../core/retrieval/normalize.js";
import { decideReindex } from "../../core/retrieval/reindex-decision.js";
import { createEmbedder } from "../embed/embedder.js";

export interface ActiveSignpost {
  id: string;
  repo: string;
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
  /** Active signposts for this repo — the caller has already scope/status-filtered. */
  signposts: readonly ActiveSignpost[];
}

interface IndexMetaRow {
  corpus_hash: string;
  embedding_model: string;
}

function vectorToBlob(vector: readonly number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

/**
 * Rebuilds signpost_vec / signpost_fts (and the embedding_model/dim mirror
 * on signposts) iff decideReindex says so, in one transaction. Full rebuild
 * only — no incremental re-embed path.
 */
export async function rebuildIndex(db: Database.Database, options: RebuildIndexOptions): Promise<void> {
  const embeddingModel = EMBEDDING_MODEL;
  const currentCorpusHash = computeCorpusHash(options.signposts);

  const meta = db.prepare("SELECT corpus_hash, embedding_model FROM index_meta WHERE id = 1").get() as
    | IndexMetaRow
    | undefined;

  const decision = decideReindex({
    indexExists: meta !== undefined,
    storedCorpusHash: meta?.corpus_hash ?? null,
    currentCorpusHash,
    storedEmbeddingModel: meta?.embedding_model ?? null,
    currentEmbeddingModel: embeddingModel,
  });

  if (decision === "skip") {
    return;
  }

  const embedder = await createEmbedder({
    modelCacheDir: options.modelCacheDir,
    allowRemoteModels: options.retrieval.allow_remote_models,
    localModelPath: options.retrieval.local_model_path,
    embeddingModel,
  });

  const embedded: Array<{ signpost: ActiveSignpost; vector: number[] }> = [];
  for (const signpost of options.signposts) {
    embedded.push({ signpost, vector: await embedder.embed(normalize(signpost.claim)) });
  }

  const insertVec = db.prepare("INSERT INTO signpost_vec (signpost_id, claim_embedding) VALUES (?, ?)");
  const insertFts = db.prepare("INSERT INTO signpost_fts (signpost_id, claim, evidence) VALUES (?, ?, ?)");
  const updateSignpost = db.prepare(
    "UPDATE signposts SET embedding_model = ?, embedding_dim = ? WHERE repo = ? AND id = ?",
  );
  const upsertMeta = db.prepare(`
    INSERT INTO index_meta (id, corpus_hash, embedding_model, updated_at)
    VALUES (1, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      corpus_hash = excluded.corpus_hash,
      embedding_model = excluded.embedding_model,
      updated_at = excluded.updated_at
  `);

  const rebuild = db.transaction(() => {
    db.prepare("DELETE FROM signpost_vec").run();
    db.prepare("DELETE FROM signpost_fts").run();

    for (const { signpost, vector } of embedded) {
      insertVec.run(signpost.id, vectorToBlob(vector));
      insertFts.run(signpost.id, signpost.claim, signpost.evidence);
      updateSignpost.run(embeddingModel, EMBEDDING_DIM, signpost.repo, signpost.id);
    }

    upsertMeta.run(currentCorpusHash, embeddingModel, new Date().toISOString());
  });

  rebuild();
}
