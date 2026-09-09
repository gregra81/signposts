// Embedding-model cache probe (R5): can this machine embed without the
// network, and if not, why.
//
// Directory existence alone was the old answer, and it was the wrong one in
// both directions. `~/.signposts/models/` is created by the first embedder
// that ever ran, so an interrupted download reported "present"; and a repo
// configured for the vendored offline layout (15-spec.md story 57) has no
// shared cache at all and reported "absent" while retrieval worked fine.
// Both are the question a developer asks doctor after a run failed offline.
//
// The two layouts differ, and that is transformers.js's doing, not ours:
// the shared cache is keyed `<cacheDir>/<repo-id>/<revision>/`, while
// `localModelPath` resolves a flat `<localModelPath>/<repo-id>/` and ignores
// the revision (see test/support/model-cache.ts, which builds both).

import { readdirSync } from "node:fs";
import path from "node:path";
import { classifyModelCache, type ModelCacheStatus } from "../../core/doctor/report.ts";
import { splitPinnedModel } from "../../core/retrieval/pinned-model.ts";

export interface ModelCacheInput {
  /** `config.paths.modelCacheDir` — global, shared by every repo. */
  modelCacheDir: string;
  /** The pinned `<repo-id>@<revision>` string (constants.EMBEDDING_MODEL). */
  embeddingModel: string;
  /** `config.retrieval.local_model_path`, or null when unset. */
  localModelPath: string | null;
}

/** True when a directory exists and holds something — a half-written cache is not warm. */
function populated(dir: string): boolean {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false; // Missing, or unreadable: either way there is nothing to load.
  }
}

export function checkModelCache(input: ModelCacheInput): ModelCacheStatus {
  const { repoId, revision } = splitPinnedModel(input.embeddingModel);

  return classifyModelCache({
    vendored:
      input.localModelPath !== null && populated(path.join(input.localModelPath, repoId)),
    pinnedRevisionCached: populated(path.join(input.modelCacheDir, repoId, revision)),
  });
}
