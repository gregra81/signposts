// What `signpost init` does to `statusLine` in the settings file, decided
// here so it can be tested without one.
//
// The status line is a place the developer may already live. Claude Code
// allows exactly one `statusLine` command, so installing ours over theirs
// would silently take away a git branch, a context meter or a cost readout
// they built and rely on. The rule is therefore: **install if the slot is
// empty, wrap if it is not.** Wrapping means our command runs theirs, prints
// what it printed, and adds a row of our own underneath
// (statusline/statusline.ts, `--wrap`).
//
// The wrapped command stays visible in the settings file rather than being
// stashed somewhere of ours. Someone who opens `settings.local.json` a year
// from now has to be able to see what happened to their status line, and to
// get it back by deleting one thing.
//
// PURE: settings in, settings out. Reading and writing the file is
// src/io/init/statusline-file.ts.

import { STATUSLINE_REFRESH_SECONDS } from "../config/constants.ts";

/** `statusLine.type` — the only value Claude Code defines. */
const COMMAND_TYPE = "command";

/**
 * How we recognise our own entry: the path of the script we install always
 * ends this way. Re-running `init` after an upgrade has to update the path
 * without wrapping the previous install in a second copy of itself.
 */
const OUR_SCRIPT_SUFFIX = "statusline/statusline.js";

const WRAP_FLAG = "--wrap";

export interface StatusLineSetting {
  type: string;
  command: string;
  [key: string]: unknown;
}

export interface Settings {
  statusLine?: StatusLineSetting;
  [key: string]: unknown;
}

/** What `init` did, so it can say so rather than changing a file in silence. */
export const STATUSLINE_OUTCOMES = {
  installed: "installed",
  wrapped: "wrapped",
  updated: "updated",
} as const;

export type StatusLineOutcome = (typeof STATUSLINE_OUTCOMES)[keyof typeof STATUSLINE_OUTCOMES];

export interface StatusLinePlan {
  settings: Settings;
  outcome: StatusLineOutcome;
  /** The command that was already there and is now wrapped, when there was one. */
  wrapped?: string;
}

/**
 * Single-quotes a command for the shell that runs the wrapper.
 *
 * `'\''` — close, escaped quote, reopen — is the only escape a single-quoted
 * shell word admits, and it is why this is not a template string: the wrapped
 * command is whatever the developer wrote, including quotes, `$` and
 * backticks, and every one of those has to survive being handed back to a
 * shell exactly as they typed it.
 */
export function shellQuote(command: string): string {
  return `'${command.split("'").join(`'\\''`)}'`;
}

/** The settings value for our script, wrapping `existing` when there is one. */
export function ourCommand(scriptPath: string, existing?: string): string {
  const base = `node ${shellQuote(scriptPath)}`;
  return existing === undefined ? base : `${base} ${WRAP_FLAG} ${shellQuote(existing)}`;
}

function isOurs(command: string): boolean {
  return command.includes(OUR_SCRIPT_SUFFIX);
}

/**
 * The command an earlier install wrapped, recovered from our own entry.
 *
 * Everything after the flag is one shell word, so unquoting is the inverse of
 * `shellQuote` and nothing more: a command we did not write never reaches
 * here.
 */
export function unwrap(command: string): string | undefined {
  const marker = ` ${WRAP_FLAG} `;
  const flag = command.indexOf(marker);
  if (flag === -1) {
    return undefined;
  }
  const quoted = command.slice(flag + marker.length).trim();
  if (quoted === "") {
    return undefined;
  }
  // Anything that is not a quoted word came from a hand edit; hand it back as
  // it stands rather than trimming characters off someone's command.
  if (!quoted.startsWith("'") || !quoted.endsWith("'") || quoted === "'") {
    return quoted;
  }
  return quoted.slice(1, -1).split(`'\\''`).join("'");
}

function readSetting(settings: Settings): StatusLineSetting | undefined {
  const existing = settings.statusLine;
  if (typeof existing !== "object" || existing === null) {
    return undefined;
  }
  return typeof existing.command === "string" && existing.command !== "" ? existing : undefined;
}

/**
 * The settings file as `init` should leave it.
 *
 * Three cases, and the middle one is the whole point of this module:
 *
 *   - nothing configured    -> ours, with a refresh so a run is visible
 *   - someone else's        -> ours wrapping theirs, their other fields kept
 *   - ours from last time   -> the same, with the script path brought up to
 *                             date and whatever it wraps still wrapped
 */
export function planStatusLine(settings: Settings, scriptPath: string): StatusLinePlan {
  const existing = readSetting(settings);

  if (existing === undefined) {
    return {
      settings: {
        ...settings,
        statusLine: {
          type: COMMAND_TYPE,
          command: ourCommand(scriptPath),
          // Set on a fresh install only, never added to a status line someone
          // else configured: their command is theirs to pace, and a git script
          // written for event-driven updates should not start running once a
          // second because we turned up. Ours is one file read. It is needed
          // at all because the bar's triggers are message-driven and a run
          // happens inside a subagent — the case the field is documented for.
          refreshInterval: STATUSLINE_REFRESH_SECONDS,
        },
      },
      outcome: STATUSLINE_OUTCOMES.installed,
    };
  }

  // Their `padding`, `refreshInterval` and anything a later Claude Code adds
  // are theirs; only the command is ours to replace.
  const wrapped = isOurs(existing.command) ? unwrap(existing.command) : existing.command;
  return {
    settings: {
      ...settings,
      statusLine: { ...existing, type: COMMAND_TYPE, command: ourCommand(scriptPath, wrapped) },
    },
    outcome: isOurs(existing.command)
      ? STATUSLINE_OUTCOMES.updated
      : STATUSLINE_OUTCOMES.wrapped,
    ...(wrapped === undefined ? {} : { wrapped }),
  };
}
