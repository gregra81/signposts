// Installs the statusLine into the repo's settings
// (src/core/init/statusline-settings.ts decides what it should say).
//
// It goes in `.claude/settings.local.json`, not `.claude/settings.json`. Two
// reasons, and both are about it being the wrong thing to commit: the command
// holds an absolute path to wherever this machine installed the package, which
// is meaningless in a teammate's checkout; and a status line is a personal
// preference, so putting one in a shared file would change what every
// colleague's terminal looks like because one of them ran `init`.
//
// It reads more files than it writes. A `statusLine` resolves by precedence —
// local, then project, then user — and Claude Code takes the whole value from
// the highest level that sets it, so writing one here replaces one in
// `~/.claude/settings.json` outright. Most people who have a status line have
// it there, so all three are read and the effective one is what gets wrapped.
//
// A settings file we cannot parse is left exactly as it is. It is the
// developer's file, it may be mid-edit, and rewriting it from a failed parse
// would drop every setting in it.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSON_INDENT } from "../../core/config/constants.ts";
import {
  planStatusLine,
  type InheritedStatusLine,
  type Settings,
  type StatusLinePlan,
} from "../../core/init/statusline-settings.ts";

/** Claude Code's per-repo config directory, as it appears in a checkout. */
const CLAUDE_DIRNAME = ".claude";
const SETTINGS_FILENAME = "settings.local.json";
/** The file a team shares. Read for an existing statusLine, never written. */
const SHARED_SETTINGS_FILENAME = "settings.json";
const STATUSLINE_SCRIPT = path.join("statusline", "statusline.js");

/** <root>/src/io/init/statusline-file.ts -> <root>. */
function packageRoot(): string {
  return path.dirname(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))));
}

/** The shipped bundle, absolute — the settings file is read from any directory. */
export function statuslineScriptPath(): string {
  return path.join(packageRoot(), STATUSLINE_SCRIPT);
}

function settingsPath(repoRoot: string): string {
  return path.join(repoRoot, CLAUDE_DIRNAME, SETTINGS_FILENAME);
}

/** The parsed settings, `{}` when there is no file, or undefined when there is one we cannot read. */
function readSettings(file: string): Settings | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return {}; // No file yet. An empty object is the same starting point.
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Settings) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The `statusLine` in force from the files below the one we write: the shared
 * project settings, then the user's own. First match wins, which is the same
 * order Claude Code resolves them in.
 */
function inheritedStatusLine(repoRoot: string, claudeConfigRoot: string): InheritedStatusLine {
  const lower = [
    path.join(repoRoot, CLAUDE_DIRNAME, SHARED_SETTINGS_FILENAME),
    path.join(claudeConfigRoot, SHARED_SETTINGS_FILENAME),
  ];
  for (const file of lower) {
    const settings = readSettings(file);
    const candidate = settings?.statusLine;
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      typeof candidate.command === "string" &&
      candidate.command !== ""
    ) {
      return candidate;
    }
  }
  return undefined;
}

export interface StatusLineInstall extends StatusLinePlan {
  /** Repo-relative, so `init` can name it in what it prints. */
  file: string;
}

/**
 * Installs or enhances the status line, or returns null when the settings file
 * is one this must not touch.
 *
 * Null is not a failure worth stopping `init` for: the rest of `init` —
 * consent, `.signposts/`, the skill — is what the tool needs to work at all,
 * and a status line is how it is seen working.
 */
export function installStatusLine(
  repoRoot: string,
  claudeConfigRoot: string,
  script: string = statuslineScriptPath(),
): StatusLineInstall | null {
  // Never point the setting at a script that is not there. A missing command
  // exits non-zero, which blanks the bar — and when we are wrapping, that
  // takes the developer's own status line down with it. `pnpm build:hooks`
  // produces this file; a package that shipped without it must change nothing.
  //
  // The path is a parameter so the absent case has a seam. The test for it
  // used to rename the real bundle aside and back, and the suite runs files in
  // parallel: the statusLine's own behaviour tests spawn that same file, and
  // caught it missing often enough to fail about one full run in three, in
  // whichever of them happened to land inside the window.
  if (!existsSync(script)) {
    return null;
  }

  const file = settingsPath(repoRoot);
  const settings = readSettings(file);
  if (settings === undefined) {
    return null;
  }

  const plan = planStatusLine(settings, script, inheritedStatusLine(repoRoot, claudeConfigRoot));
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(plan.settings, null, JSON_INDENT) + "\n", "utf8");
  } catch {
    return null;
  }
  return { ...plan, file: path.join(CLAUDE_DIRNAME, SETTINGS_FILENAME) };
}
