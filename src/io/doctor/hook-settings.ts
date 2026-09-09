// Read-only check for a signposts SessionStart hook in the repo's Claude Code
// settings (R5). Interpretation of the parsed JSON is
// src/core/doctor/report.ts's detectSignpostSessionStartHook; this module only
// reads the files.
//
// Both files, because Claude Code reads both and a developer may have used
// either: `.claude/settings.json` is the one the team shares, and
// `.claude/settings.local.json` is the personal one — which is where `init`
// puts the statusLine, for reasons that apply to a hook command holding an
// absolute path just as much (src/core/init/statusline-settings.ts). Checking
// only the shared file reported "not installed" to a developer looking
// straight at their own installed hook.

import { readFileSync } from "node:fs";
import path from "node:path";
import { detectSignpostSessionStartHook } from "../../core/doctor/report.ts";

const CLAUDE_DIRNAME = ".claude";
const SETTINGS_FILENAMES = ["settings.json", "settings.local.json"] as const;

function readSettings(file: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return undefined; // No settings file is the ordinary case, not a failure.
  }

  try {
    return JSON.parse(raw);
  } catch {
    return undefined; // Hand-edited into invalid JSON: nothing to report on.
  }
}

export function checkSessionStartHookInstalled(repoRoot: string): boolean {
  return SETTINGS_FILENAMES.some((filename) =>
    detectSignpostSessionStartHook(readSettings(path.join(repoRoot, CLAUDE_DIRNAME, filename))),
  );
}
