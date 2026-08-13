// Filesystem read/write for the repo's CLAUDE.md pointer (R3). Idempotency
// and content decisions live in src/core/init/policy.ts's
// ensureClaudeMdPointer; this module only does the read and the write.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const CLAUDE_MD_FILENAME = "CLAUDE.md";

function claudeMdPath(repoRoot: string): string {
  return path.join(repoRoot, CLAUDE_MD_FILENAME);
}

/** Undefined if CLAUDE.md does not exist yet. */
export function readClaudeMd(repoRoot: string): string | undefined {
  try {
    return readFileSync(claudeMdPath(repoRoot), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export function writeClaudeMd(repoRoot: string, content: string): void {
  mkdirSync(repoRoot, { recursive: true });
  writeFileSync(claudeMdPath(repoRoot), content, "utf8");
}
