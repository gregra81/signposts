// Thin filesystem reader for the two config.yaml layers described in
// 12-wire-contracts.md ("## Config"). src/core/config/resolve.ts stays
// pure and takes file contents as arguments; this is the only place that
// touches the filesystem to produce them.

import { readFileSync } from "node:fs";
import path from "node:path";
import { SIGNPOSTS_DIRNAME } from "../core/config/constants.ts";

function readIfExists(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/** Reads `.signposts/config.yaml` under the repo root, or undefined if absent. */
export function readRepoConfigFile(repoRoot: string): string | undefined {
  return readIfExists(path.join(repoRoot, SIGNPOSTS_DIRNAME, "config.yaml"));
}

/** Reads `~/.signposts/config.yaml`, or undefined if absent. */
export function readUserConfigFile(homeDir: string): string | undefined {
  return readIfExists(path.join(homeDir, SIGNPOSTS_DIRNAME, "config.yaml"));
}
