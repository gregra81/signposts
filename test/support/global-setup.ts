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
  LOCAL_MODEL_MARKER_FILE,
  MODEL_REPO,
  MODEL_REVISION,
  TEST_LOCAL_MODELS,
  localModelReady,
  testModelCache,
} from "./model-cache.ts";

/**
 * What a feature-extraction pipeline needs on disk to load offline, with the
 * marker deliberately absent — see the copy loop.
 */
const MODEL_FILES = ["config.json", "tokenizer_config.json"];
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
  // LOCAL_MODEL_MARKER_FILE is copied last, and that ordering is the whole
  // point of the constant. localModelReady() takes its presence to mean the
  // offline copy is complete, so anything that can interrupt the copy — Ctrl-C,
  // a full disk, a killed CI step — must not be able to leave it behind
  // without the ~23MB of weights beside it. It used to be second of four, and
  // an interrupted first run poisoned node_modules/.cache permanently: every
  // later run skipped the download and the behaviour suites failed offline on
  // a missing ONNX file, with nothing pointing at the directory to delete.
  for (const file of [...MODEL_FILES, ONNX_FILE, LOCAL_MODEL_MARKER_FILE]) {
    copyFileSync(path.join(from, file), path.join(to, file));
  }

  if (!localModelReady()) {
    throw new Error(`model copy incomplete: ${LOCAL_MODEL_MARKER} missing`);
  }
}
