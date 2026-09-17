// Production wiring for bin/signpost.js (R6): resolves config from the real
// filesystem/env/cwd/homedir and constructs the three production ports,
// then hands both to createApp. This — together with bin/signpost.js
// itself — is the only place any port is constructed; every command
// downstream receives ports already built, never builds its own (R2).
//
// What a run needs is opened by `openRun` (./open-run.ts) rather than here:
// its resources live for one invocation, and `doctor` has to run in a repo
// with no database at all. The model port inside it is `hostModel` — a model
// call halts the run and is answered by the Claude Code session that started
// it (src/graph/host-model.ts).
//
// `repo` (the "owner/name" git-origin key) is NOT resolved here: `doctor`
// must run in any repo, including one with no GitHub origin, so eagerly
// resolving it in this composition root would crash `doctor` before it
// even runs. Each of `init`/`index` resolves its own `repo` lazily instead
// (src/io/git/remote-origin.ts's resolveRepo) and fails gracefully if it
// can't.

import { readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { App } from "../app.ts";
import { createApp } from "../app.ts";
import { EXIT_CODES } from "../core/cli/exit-codes.ts";
import { resolveConfig } from "../core/config/resolve.ts";
import { readRepoConfigFile, readUserConfigFile } from "./config.ts";
import { findRepoRoot } from "./git/repo-root.ts";
import { openRun } from "./open-run.ts";
import { prefetchModel } from "./embed/prefetch.ts";

/** Set by `.claude-plugin/plugin.json` to `${CLAUDE_PROJECT_DIR}` — see below. */
const REPO_ROOT_ENV_VAR = "SIGNPOSTS_REPO_ROOT";

/**
 * The repository this invocation is about.
 *
 * The git root above `process.cwd()` for everything a person types, and
 * `SIGNPOSTS_REPO_ROOT`
 * for the one caller that cannot rely on a working directory: the MCP server
 * in `.claude-plugin/plugin.json`, which Claude Code starts itself. The plugin
 * documentation says which variables a manifest may substitute but says
 * nothing about the working directory a server is spawned in, and a repoRoot
 * guessed wrong is not an error — it is a different state directory, an index
 * that appears not to exist, and a search that quietly answers "nothing
 * recorded here". So the manifest passes the project root explicitly.
 *
 * Resolved through `realpathSync` for the reason the hook resolves it too
 * (hooks/session-start.ts): every state path is keyed on `sha256(repoRoot)`,
 * `process.cwd()` is always reported resolved, and a checkout reached through
 * a symlink would otherwise hash to a second, empty state directory.
 *
 * A path that does not resolve is used as given and said out loud. "Fails
 * later with its own message" holds for the commands a person types; it does
 * not hold for `mcp`, the caller this override exists for, where a wrong value
 * is a state directory nothing has ever written and a tool that answers "no
 * search index has been built in this checkout yet" forever. That is the
 * silent failure this whole function is here to prevent, so the one case it
 * cannot prevent gets a line on stderr — the MCP server's stderr is where its
 * diagnostics already go, and stdout is the JSON-RPC wire.
 *
 * Read here, at the composition root, and nowhere below it (R7).
 */
function resolveRepoRoot(override: string | undefined): string {
  if (override === undefined || override === "") {
    // The working directory is where the shell happens to be, not what the
    // invocation is about. Run from `<repo>/lib`, taking it literally made
    // `sessions` print an empty list at exit 0 and moved the whole state
    // directory with the shell (./git/repo-root.ts). Outside a repository
    // there is nothing to climb to, and the commands that need one say so
    // themselves.
    const cwd = process.cwd();
    return findRepoRoot(cwd) ?? cwd;
  }
  try {
    return realpathSync(override);
  } catch {
    process.stderr.write(
      `signposts: ${REPO_ROOT_ENV_VAR}=${override} does not resolve to a directory — using it as given, ` +
        `which is very likely a repository nothing has recorded anything for.
`,
    );
    return override;
  }
}

/**
 * The installed version, from package.json. This file is `src/io/` in a
 * checkout and `dist/io/` in an install, two levels below the package root
 * either way.
 */
function packageVersion(): string | undefined {
  try {
    const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
    const parsed = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

export function buildProductionApp(): App {
  const repoRoot = resolveRepoRoot(process.env[REPO_ROOT_ENV_VAR]);
  const homeDir = os.homedir();

  let config;
  try {
    config = resolveConfig({
      repoRoot,
      homeDir,
      repoFileContents: readRepoConfigFile(repoRoot),
      userFileContents: readUserConfigFile(homeDir),
      env: process.env,
      claudeConfigDir: process.env["CLAUDE_CONFIG_DIR"],
    });
  } catch (error) {
    // A bad config value is the developer's to fix, and its message already
    // names the variable or the key. bin/signpost.js has no handler, so this
    // used to reach the terminal as a Node stack trace (19-value-to-a-user.md
    // item 5). Every command fails the same way, since none of them can run
    // without a config.
    const message = error instanceof Error ? error.message : String(error);
    return {
      run: () => {
        process.stderr.write(`signposts: ${message}\n`);
        return Promise.resolve(EXIT_CODES.failure);
      },
    };
  }

  return createApp({ config, openRun, prefetchModel, ...versionField() });
}

function versionField(): { version?: string } {
  const version = packageVersion();
  return version === undefined ? {} : { version };
}
