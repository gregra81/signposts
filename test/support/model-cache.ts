// The embedding model the behaviour suite runs against, and the reason the
// suite can run with the network off.
//
// Each of these test files used to mkdtemp its own cache dir and rmSync it in
// teardown, with `allow_remote_models: true`. So the model was fetched from
// huggingface.co on every run of every file and thrown away afterwards: the
// suite passed only because the network happened to be there. With it removed,
// 18 tests across four files failed on ENOTFOUND.
//
// A warm cache alone does not fix it. With `allowRemoteModels: true`,
// transformers.js fetches file metadata before touching the cache, so even a
// fully populated cacheDir still needs the network. Loading offline means
// `allowRemoteModels: false` plus `localModelPath`, which resolves from a flat
// <localModelPath>/<repo>/ layout and ignores the pinned revision.
//
// So the model is downloaded once, into the shared cache, and copied into that
// flat layout. global-setup.ts does it before the suite runs; every run after
// the first needs no network at all.
//
// Both directories live under node_modules/.cache: already git-ignored,
// already understood as regenerable, and not the user's real
// ~/.signposts/models — a test run should not write into the cache the
// installed product uses.

import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { EMBEDDING_MODEL } from "../../src/core/config/constants.js";
import { splitPinnedModel } from "../../src/core/retrieval/pinned-model.js";

const CACHE_ROOT = path.join(process.cwd(), "node_modules", ".cache");

/** Where transformers.js downloads to, keyed by repo and revision. */
export const TEST_MODEL_CACHE = path.join(CACHE_ROOT, "signposts-test-models");

/** The flat layout `localModelPath` resolves against. */
export const TEST_LOCAL_MODELS = path.join(CACHE_ROOT, "signposts-test-local");

export const { repoId: MODEL_REPO, revision: MODEL_REVISION } = splitPinnedModel(EMBEDDING_MODEL);

/** The file whose presence means the offline copy is complete. */
export const LOCAL_MODEL_MARKER = path.join(TEST_LOCAL_MODELS, MODEL_REPO, "tokenizer.json");

export function testModelCache(): string {
  mkdirSync(TEST_MODEL_CACHE, { recursive: true });
  return TEST_MODEL_CACHE;
}

/**
 * The `localModelPath` tests should pass, alongside `allowRemoteModels: false`.
 * global-setup.ts guarantees it is populated before any test runs.
 */
export function testLocalModelPath(): string {
  return TEST_LOCAL_MODELS;
}

export function localModelReady(): boolean {
  return existsSync(LOCAL_MODEL_MARKER);
}
