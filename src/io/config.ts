// Thin filesystem reader for the config.yaml layers described in
// 12-wire-contracts.md ("## Config"), and the writer for the one `init` sets.
// src/core/config/resolve.ts stays pure and takes file contents as arguments;
// this is the only place that touches the filesystem to produce them.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CONFIG_FILENAME, SIGNPOSTS_DIRNAME } from "../core/config/constants.ts";
import { checkoutConfigFile } from "../core/config/paths.ts";

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
  return readIfExists(path.join(repoRoot, SIGNPOSTS_DIRNAME, CONFIG_FILENAME));
}

/** Reads `~/.signposts/config.yaml`, or undefined if absent. */
export function readUserConfigFile(homeDir: string): string | undefined {
  return readIfExists(path.join(homeDir, SIGNPOSTS_DIRNAME, CONFIG_FILENAME));
}

/** Reads this checkout's own `config.yaml` in its state directory, or undefined if absent. */
export function readCheckoutConfigFile(repoRoot: string, homeDir: string): string | undefined {
  return readIfExists(checkoutConfigFile(repoRoot, homeDir));
}

/**
 * Records where this checkout's signposts are kept. The file holds that one
 * key, so it is written whole: the hook and the mod read it with a regex, not
 * a YAML parser.
 */
export function writeCheckoutStorage(filePath: string, storage: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `storage: ${storage}\n`, "utf8");
}
