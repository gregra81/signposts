// Derives the concrete, per-repo state paths from the path *pieces* in
// ./constants.ts. The constants module holds only the building blocks —
// directory names and filenames — because the concrete paths depend on
// `repoRoot` and `homeDir`, which are per-invocation inputs, not tunables.
//
// `repoRoot` and `homeDir` are passed in explicitly: this module calls
// neither `os.homedir()` nor reads any ambient state itself.

import { createHash } from "node:crypto";
import path from "node:path";
import {
  CHECKPOINT_FILENAME,
  DB_FILENAME,
  INDEX_FILENAME,
  LOCKFILE_FILENAME,
  MODEL_CACHE_DIRNAME,
  SIGNPOSTS_DIRNAME,
  STATUSLINE_FILENAME,
} from "./constants.ts";

export interface DerivedPaths {
  /** The repoRoot derivePaths was called with, unnormalised. */
  repoRoot: string;
  /** First 12 hex chars of sha256(repoRoot). */
  repoHash: string;
  stateDir: string;
  dbPath: string;
  checkpointPath: string;
  statuslineState: string;
  lockfile: string;
  /** Global — NOT under stateDir. Shared across every repo on the machine. */
  modelCacheDir: string;
  knowledgeDir: string;
  indexFile: string;
}

/** sha256(repoRoot), hex-encoded, first 12 characters — repoRoot taken as given, unnormalised. */
export function hashRepoRoot(repoRoot: string): string {
  return createHash("sha256").update(repoRoot).digest("hex").slice(0, 12);
}

export function derivePaths(repoRoot: string, homeDir: string): DerivedPaths {
  const repoHash = hashRepoRoot(repoRoot);
  const globalRoot = path.join(homeDir, SIGNPOSTS_DIRNAME);
  const stateDir = path.join(globalRoot, repoHash);
  const knowledgeDir = path.join(repoRoot, SIGNPOSTS_DIRNAME);

  return {
    repoRoot,
    repoHash,
    stateDir,
    dbPath: path.join(stateDir, DB_FILENAME),
    checkpointPath: path.join(stateDir, CHECKPOINT_FILENAME),
    statuslineState: path.join(stateDir, STATUSLINE_FILENAME),
    lockfile: path.join(stateDir, LOCKFILE_FILENAME),
    modelCacheDir: path.join(globalRoot, MODEL_CACHE_DIRNAME),
    knowledgeDir,
    indexFile: path.join(knowledgeDir, INDEX_FILENAME),
  };
}
