// Embedding-model cache probe (R5): can this machine embed, and if not, what
// has to happen before it can.
//
// Directory existence was the old answer, and it was wrong in both
// directions. `~/.signposts/models/` is created by the first embedder that
// ever ran, so an interrupted download reported "present"; and a repo
// configured for the vendored offline layout (15-spec.md story 57) has no
// shared cache at all and reported "absent" while retrieval worked fine. Both
// are the question a developer asks doctor after a run failed offline.
//
// So this probes the weights themselves rather than a directory.
// transformers.js caches file by file, renaming each completed download into
// place, so a first run interrupted after `config.json` and `tokenizer.json`
// leaves a populated directory with no model in it — which is the exact
// failure this check exists to name. ../../core/retrieval/model-files.ts holds
// the paths, shared with the embedder that loads them.

import { existsSync } from "node:fs";
import { classifyModelCache, type ModelCacheStatus } from "../../core/doctor/report.ts";
import { splitPinnedModel } from "../../core/retrieval/pinned-model.ts";
import { cachedWeightsPath, vendoredWeightsPath } from "../../core/retrieval/model-files.ts";

export interface ModelCacheInput {
  /** `config.paths.modelCacheDir` — global, shared by every repo. */
  modelCacheDir: string;
  /** The pinned `<repo-id>@<revision>` string (constants.EMBEDDING_MODEL). */
  embeddingModel: string;
  /** `config.retrieval.local_model_path`, or null when unset. */
  localModelPath: string | null;
  /** `config.retrieval.allow_remote_models` — whether a cold cache can still fill itself. */
  allowRemoteModels: boolean;
}

export function checkModelCache(input: ModelCacheInput): ModelCacheStatus {
  const { repoId, revision } = splitPinnedModel(input.embeddingModel);

  return classifyModelCache({
    vendored:
      input.localModelPath !== null && existsSync(vendoredWeightsPath(input.localModelPath, repoId)),
    pinnedRevisionCached: existsSync(cachedWeightsPath(input.modelCacheDir, repoId, revision)),
    remoteAllowed: input.allowRemoteModels,
  });
}
