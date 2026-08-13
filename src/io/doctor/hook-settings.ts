// Read-only check of the repo's `.claude/settings.json` for a signposts
// SessionStart hook entry (R5). Nothing installs this hook yet (Slice C) —
// this always reports absent until that lands. Interpretation of the
// parsed JSON is src/core/doctor/report.ts's detectSignpostSessionStartHook;
// this module only reads the file.

import { readFileSync } from "node:fs";
import path from "node:path";
import { detectSignpostSessionStartHook } from "../../core/doctor/report.ts";

export function checkSessionStartHookInstalled(repoRoot: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(path.join(repoRoot, ".claude", "settings.json"), "utf8");
  } catch {
    return false;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }

  return detectSignpostSessionStartHook(parsed);
}
