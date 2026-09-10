// Where the embedding model's weights sit on disk, in each of the two layouts
// transformers.js resolves against.
//
// Two callers need this and they must not disagree: src/io/embed/embedder.ts
// asks for the quantized build, and src/io/doctor/model-cache.ts reports
// whether that build is on disk. A doctor probing for a file the embedder
// never loads is a check that reports what ought to be true.
//
// The filename is transformers.js's own composition, not ours: the ONNX file
// carries the suffix its DEFAULT_DTYPE_SUFFIX_MAPPING gives the requested
// dtype (`q8` -> `_quantized`, in utils/dtypes.js). Change EMBEDDING_DTYPE and
// the weights file changes with it.

import path from "node:path";

/**
 * Quantized (q8): ~23MB against ~90MB for fp32, which 05-retrieval.md asks for
 * explicitly. transformers.js defaults to fp32 on the node/cpu backend, so
 * this is requested rather than assumed.
 */
export const EMBEDDING_DTYPE = "q8";

/** The ONNX weights, relative to whichever directory holds one copy of the model. */
export const EMBEDDING_WEIGHTS_FILE = path.join("onnx", "model_quantized.onnx");

/**
 * The shared cache: `<cacheDir>/<repo-id>/<revision>/…`, so one machine holds
 * one copy per pinned revision across every repo (13-constants.md's
 * MODEL_CACHE_DIR).
 */
export function cachedWeightsPath(cacheDir: string, repoId: string, revision: string): string {
  return path.join(cacheDir, repoId, revision, EMBEDDING_WEIGHTS_FILE);
}

/**
 * The vendored copy `retrieval.local_model_path` points at: flat,
 * `<localModelPath>/<repo-id>/…`, with no revision in the path at all —
 * transformers.js ignores the pinned revision on this route (15-spec.md story
 * 57, and test/support/model-cache.ts, which builds both layouts).
 */
export function vendoredWeightsPath(localModelPath: string, repoId: string): string {
  return path.join(localModelPath, repoId, EMBEDDING_WEIGHTS_FILE);
}
