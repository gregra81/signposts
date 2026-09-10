// Read-only check for a signposts SessionStart hook in the repo's Claude Code
// settings (R5). Interpretation of the parsed JSON is
// src/core/doctor/report.ts's detectSignpostSessionStartHook; this module only
// reads the files.
//
// All three files Claude Code reads for `SessionStart`, because a developer
// may have used any of them: `.claude/settings.json` is the one the team
// shares, `.claude/settings.local.json` is the personal one in this checkout
// (where `init` puts the statusLine), and `~/.claude/settings.json` is the
// personal one for every repo on the machine. The last is where a hook is most
// likely to be, since its command holds an absolute path to this machine's
// install (src/core/init/statusline-settings.ts) — and it is a hook installed
// once, globally, that a repo-only check reported as missing while it fired on
// every session start.
//
// The same files also answer the question the plugin raised. Since
// `.claude-plugin/plugin.json` started registering the hook through
// `hooks/hooks.json`, no settings file mentions it, and this module told every
// plugin user that a hook firing on every session was not installed
// (18-end-to-end-gaps.md, "Spec drift"). `enabledPlugins` is what those files
// do carry, so both questions are answered from one read.

import { readFileSync } from "node:fs";
import path from "node:path";
import { detectSignpostPlugin, detectSignpostSessionStartHook } from "../../core/doctor/report.ts";
import type { HookInstall } from "../../core/doctor/report.ts";

const CLAUDE_DIRNAME = ".claude";
const SHARED_SETTINGS_FILENAME = "settings.json";
const LOCAL_SETTINGS_FILENAME = "settings.local.json";

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

/**
 * `claudeConfigRoot` is Claude Code's own config directory — the parent of
 * `config.paths.transcriptRoot`, which is where the composition root already
 * resolved it (`CLAUDE_CONFIG_DIR` moves both). Read from there rather than
 * from `homedir()` here, same as `init` does.
 */
export function checkSessionStartHookInstalled(repoRoot: string, claudeConfigRoot: string): HookInstall {
  const settings = [
    path.join(repoRoot, CLAUDE_DIRNAME, SHARED_SETTINGS_FILENAME),
    path.join(repoRoot, CLAUDE_DIRNAME, LOCAL_SETTINGS_FILENAME),
    path.join(claudeConfigRoot, SHARED_SETTINGS_FILENAME),
  ].map(readSettings);

  // The plugin first: it is the documented install now, and a repo with both
  // is one that predates it, where the plugin is what is actually firing.
  if (settings.some((parsed) => detectSignpostPlugin(parsed))) {
    return "plugin";
  }
  return settings.some((parsed) => detectSignpostSessionStartHook(parsed)) ? "settings" : "absent";
}
