// Local embeddings via @huggingface/transformers (transformers.js), the
// only IO in the embedding path — everything else (normalisation, corpus
// hashing, the reindex decision) lives in src/core/retrieval/ and is
// plain and IO-free. See 05-retrieval.md "Embeddings".
//
// `env.cacheDir` is set from the caller-supplied `modelCacheDir` (global,
// from paths.ts's derivePaths) rather than read from the environment here
// — this module calls neither os.homedir() nor hardcodes a path, matching
// the pattern paths.ts itself documents.

import { env, pipeline } from "@huggingface/transformers";
import { EMBEDDING_DIM } from "../../core/config/constants.js";
import { splitPinnedModel } from "../../core/retrieval/pinned-model.js";

// transformers.js always joins env.localModelPath into its file-resolution
// paths, even when allowRemoteModels is true and no local override is in
// play — a literal null there crashes every model load. Captured once at
// import time, before configureEmbedEnv ever runs, so a null
// `localModelPath` option resets to transformers.js's own default instead
// of leaving a previous call's vendored path stuck (the bug this fixes).
const DEFAULT_LOCAL_MODEL_PATH = env.localModelPath;

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

export interface CreateEmbedderOptions {
  /** Global model cache dir (paths.ts's modelCacheDir), not per-repo state. */
  modelCacheDir: string;
  allowRemoteModels: boolean;
  localModelPath: string | null;
  /** Pinned "<repo-id>@<revision>" string — constants.EMBEDDING_MODEL in production. */
  embeddingModel: string;
}

/**
 * Points transformers.js's global `env` at the caller-supplied cache dir
 * and remote/local model policy. Split out from `createEmbedder` so a test
 * can assert what was configured without triggering a pipeline load (and
 * therefore a model download) — see test/unit/io/embed for the seam this
 * enables.
 */
export function configureEmbedEnv(options: Pick<CreateEmbedderOptions, "modelCacheDir" | "allowRemoteModels" | "localModelPath">): void {
  env.cacheDir = options.modelCacheDir;
  env.allowRemoteModels = options.allowRemoteModels;
  env.localModelPath = options.localModelPath ?? DEFAULT_LOCAL_MODEL_PATH;
}

export async function createEmbedder(options: CreateEmbedderOptions): Promise<Embedder> {
  configureEmbedEnv(options);
  const { repoId, revision } = splitPinnedModel(options.embeddingModel);
  // Quantized (q8) build: ~23MB vs. ~90MB fp32 for this model. transformers.js
  // defaults to fp32 on the node/cpu backend — 05-retrieval.md calls for the
  // quantized build explicitly, so this is requested rather than assumed.
  const extractor = await pipeline("feature-extraction", repoId, { revision, dtype: "q8" });

  return {
    async embed(texts: string[]): Promise<number[][]> {
      const output = await extractor(texts, { pooling: "mean", normalize: true });
      const flat = Array.from(output.data as ArrayLike<number>);
      if (flat.length !== texts.length * EMBEDDING_DIM) {
        throw new Error(
          `embedder produced ${flat.length} numbers for ${texts.length} texts, expected ${texts.length} * EMBEDDING_DIM=${EMBEDDING_DIM}`,
        );
      }
      return texts.map((_, i) => flat.slice(i * EMBEDDING_DIM, (i + 1) * EMBEDDING_DIM));
    },
  };
}
