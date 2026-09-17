// The embedding model, fetched at `signpost init` (05-retrieval.md: "Prefetch
// happens at `signpost init`, with progress").
//
// Without this the download happened lazily, and the first thing to need the
// model was the detached worker or a `search_signposts` call inside a Claude
// turn — a multi-second stall nobody could see, or an empty search for a
// reason nobody was told (19-value-to-a-user.md item 12).
//
// A failure never fails `init`. Consent is already recorded by the time this
// runs, and everything but meaning-based search works without the model: the
// search falls back to keywords and says so. So what a person needs is the one
// line saying what happened, and `doctor` for the detail.

import type { ResolvedConfig } from "../../core/config/resolve.ts";
import { EMBEDDING_MODEL } from "../../core/config/constants.ts";
import { checkModelCache } from "../doctor/model-cache.ts";
import { createEmbedder } from "./embedder.ts";

export async function prefetchModel(config: ResolvedConfig, say: (line: string) => void): Promise<void> {
  const settings = {
    modelCacheDir: config.paths.modelCacheDir,
    allowRemoteModels: config.retrieval.allow_remote_models,
    localModelPath: config.retrieval.local_model_path,
    embeddingModel: EMBEDDING_MODEL,
  };

  const status = checkModelCache(settings);
  if (status === "warm" || status === "vendored") {
    return; // Already on this machine: once per machine, not once per repo.
  }
  if (status === "unavailable") {
    say(
      "the embedding model is not on this machine and retrieval.allow_remote_models is off, so it was not downloaded. " +
        "Search matches by keyword until it is available; `signpost doctor` shows where it is looked for.",
    );
    return;
  }

  say(`downloading the embedding model (${EMBEDDING_MODEL}), once for this machine…`);
  try {
    await createEmbedder(settings);
    say("embedding model ready.");
  } catch (error) {
    say(
      `could not download the embedding model: ${String(error)}. ` +
        "Search matches by keyword until it is available, and the next `signpost index` tries again.",
    );
  }
}
