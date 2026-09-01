// Downloads the embedding model once, so the suite itself never needs the
// network. See model-cache.ts for why a warm cacheDir is not enough on its own.
//
// Runs before any test file. On a machine that already has the flat local copy
// it does nothing at all, which is every run after the first.

import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { env, pipeline } from "@huggingface/transformers";
import {
  LOCAL_MODEL_MARKER,
  MODEL_REPO,
  MODEL_REVISION,
  TEST_LOCAL_MODELS,
  localModelReady,
  testModelCache,
} from "./model-cache.ts";

/** What a feature-extraction pipeline needs on disk to load offline. */
const MODEL_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json"];
const ONNX_FILE = path.join("onnx", "model_quantized.onnx");

export default async function setup(): Promise<void> {
  if (localModelReady()) {
    return;
  }

  const cacheDir = testModelCache();
  env.cacheDir = cacheDir;
  env.allowRemoteModels = true;

  // Populates cacheDir/<repo>/<revision>/. The q8 build is what
  // src/io/embed/embedder.ts asks for, so this fetches the same files.
  await pipeline("feature-extraction", MODEL_REPO, { revision: MODEL_REVISION, dtype: "q8" });

  const from = path.join(cacheDir, MODEL_REPO, MODEL_REVISION);
  const to = path.join(TEST_LOCAL_MODELS, MODEL_REPO);
  mkdirSync(path.join(to, "onnx"), { recursive: true });
  for (const file of [...MODEL_FILES, ONNX_FILE]) {
    copyFileSync(path.join(from, file), path.join(to, file));
  }

  if (!localModelReady()) {
    throw new Error(`model copy incomplete: ${LOCAL_MODEL_MARKER} missing`);
  }
}
