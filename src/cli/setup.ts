// Setting a repo up for signposts, done by the first command that needs it.
//
// It was `signpost init`: typed by hand, a consent prompt, then files in the
// working tree to commit — three steps before anything had happened, for a
// tool nobody had seen work. Now the developer says yes to the session's offer
// to run, and the first `sessions`, `run` or `resume` sets the repo up on the
// way through (19-value-to-a-user.md, "Fewer human steps"). `init` still runs
// the same steps for anyone who wants them without a run.
//
// What it writes is all local: the consent row in the state database, and the
// status line and the loop's allow rules in `.claude/settings.local.json`,
// which is then kept out of git. Nothing in the checkout the team shares — the
// CLAUDE.md pointer rides in the first signposts commit instead
// (src/io/commit/commit-port.ts), and the skill ships in the plugin.
//
// Everything it says goes to stderr: `sessions`, `run` and `resume` print one
// JSON object on stdout, and a line of prose in front of it breaks the reader.

import path from "node:path";
import type { ResolvedConfig } from "../core/config/resolve.ts";
import { STATUSLINE_OUTCOMES } from "../core/init/statusline-settings.ts";
import { openDb } from "../io/db/migrate.ts";
import { markConsented } from "../io/db/repo-state.ts";
import { excludeFromGit } from "../io/git/exclude.ts";
import { resolveRepo } from "../io/git/remote-origin.ts";
import { readConsent } from "../io/init/consent-state.ts";
import { installPermissions, installStatusLine } from "../io/init/statusline-file.ts";

export interface SetupInput {
  config: ResolvedConfig;
  repoRoot: string;
  /** One line per thing done, without the `signposts: ` prefix. */
  say: (line: string) => void;
}

export type SetupOutcome =
  | { status: "ready" }
  /** No `owner/name` origin: nothing to key the repo on. The caller decides whether that is fatal. */
  | { status: "no-origin" }
  | { status: "failed"; reason: string };

/** Sets the repo up whether or not it was already; every step is idempotent. */
export function setUpRepo({ config, repoRoot, say }: SetupInput): SetupOutcome {
  const repo = resolveRepo(repoRoot);
  if (repo === null) {
    return { status: "no-origin" };
  }

  try {
    const db = openDb(config.paths.dbPath);
    try {
      markConsented(db, repo);
    } finally {
      db.close();
    }
  } catch {
    return { status: "failed", reason: `database at ${config.paths.dbPath} is corrupt or unreadable — run \`signpost doctor\`.` };
  }

  const statusLine = installStatusLine(repoRoot, claudeConfigRoot(config));
  if (statusLine?.outcome === STATUSLINE_OUTCOMES.wrapped && statusLine.wrapped !== undefined) {
    say(`status line added to ${statusLine.file}, wrapping the one you had (${statusLine.wrapped}).`);
  } else if (statusLine?.outcome === STATUSLINE_OUTCOMES.installed) {
    say(`status line installed in ${statusLine.file}.`);
  }

  const added = installPermissions(repoRoot, config.paths.repliesPath);
  if (added !== null && added.length > 0) {
    // The rule strings themselves read as noise to a developer — one of them is
    // a 60-character absolute path in permission syntax, double slash and all.
    // Say what they let Claude do instead; the file is there to read.
    say("Claude can now run signpost and save your answers to a run's questions without asking each time (.claude/settings.local.json).");
  }

  // Claude Code keeps this file out of commits only when it wrote the file
  // itself; one written here is ours to ignore (19-value-to-a-user.md, open
  // item 18). It holds this machine's install path.
  const settingsFile = path.join(".claude", "settings.local.json");
  if (excludeFromGit(repoRoot, settingsFile)) {
    say(`added ${settingsFile} to .git/info/exclude.`);
  }

  return { status: "ready" };
}

/**
 * Sets the repo up if nothing has yet, for the commands the skill drives.
 * `failed` when it could not be, already reported through `fail`; `set-up`
 * when this call did it, so the caller can do what `init` would have too.
 *
 * No origin is deferred rather than refused, as the consent gate did before
 * it: `openRun` turns the repo away a moment later naming the missing origin,
 * which is the thing the developer has to fix.
 */
export function ensureSetUp(
  input: SetupInput & { fail: (message: string) => void },
): "ready" | "set-up" | "failed" {
  const repo = resolveRepo(input.repoRoot);
  if (repo === null) {
    return "ready";
  }
  let ready: boolean;
  try {
    ready = readConsent(input.config.paths.dbPath, repo);
  } catch {
    input.fail(`database at ${input.config.paths.dbPath} is corrupt or unreadable — run \`signpost doctor\`.`);
    return "failed";
  }
  if (ready) {
    return "ready";
  }
  const outcome = setUpRepo(input);
  if (outcome.status === "failed") {
    input.fail(outcome.reason);
    return "failed";
  }
  return "set-up";
}

/**
 * Claude Code's config directory, where the user's own settings live. Taken
 * from the transcript root rather than from `homedir()`, because that is the
 * path the composition root already resolved (R7).
 */
function claudeConfigRoot(config: ResolvedConfig): string {
  return path.dirname(config.paths.transcriptRoot);
}
