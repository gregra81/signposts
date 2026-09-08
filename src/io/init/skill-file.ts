// Writes the skill `signpost init` installs into the repository
// (src/core/init/skill.ts holds what it says).
//
// Overwritten on every accepted `init`, deliberately: the skill describes the
// CLI's commands and reply shapes, so an older copy left in place after an
// upgrade would drive a run with instructions that no longer match it.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SKILL_DIR, SKILL_DOC, SKILL_FILENAME } from "../../core/init/skill.ts";

/** The path written, so `init` can name it in what it prints. */
export function writeSkill(repoRoot: string): string {
  const directory = path.join(repoRoot, SKILL_DIR);
  mkdirSync(directory, { recursive: true });
  const skillPath = path.join(directory, SKILL_FILENAME);
  writeFileSync(skillPath, SKILL_DOC, "utf8");
  return path.join(SKILL_DIR, SKILL_FILENAME);
}
