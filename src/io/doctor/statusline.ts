// Whether the status line `init` installed still points at a script that
// exists (19-value-to-a-user.md item 6). Only `.claude/settings.local.json`:
// that is the one file `init` writes it to (../init/statusline-file.ts), and a
// status line anywhere else is the developer's, not ours to judge.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { StatusLineFact } from "../../core/doctor/report.ts";
import { ourScriptPath } from "../../core/init/statusline-settings.ts";

export function checkStatusLine(repoRoot: string): StatusLineFact {
  let command: unknown;
  try {
    const settings = JSON.parse(readFileSync(path.join(repoRoot, ".claude", "settings.local.json"), "utf8")) as {
      statusLine?: { command?: unknown };
    };
    command = settings.statusLine?.command;
  } catch {
    return { state: "absent" }; // No file, or one mid-edit: nothing of ours to check.
  }

  const scriptPath = typeof command === "string" ? ourScriptPath(command) : undefined;
  if (scriptPath === undefined) {
    return { state: "absent" };
  }
  return existsSync(scriptPath) ? { state: "ok" } : { state: "missing", scriptPath };
}
