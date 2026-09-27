// The consent row, as setup persists it (R3, src/cli/setup.ts).
//
// `sessions`, `run` and `resume` set a repo up the first time through, which
// also writes the status line and allow rules into settings.local.json. A
// behaviour test about the loop writes the row instead, so it runs as a repo
// already set up and none of that setup is what it is about.

import { execFileSync } from "node:child_process";
import type { ResolvedConfig } from "../../../src/core/config/resolve.js";
import { openDb } from "../../../src/io/db/migrate.js";
import { markBootstrapComplete, markConsented } from "../../../src/io/db/repo-state.js";
import { resolveRepo } from "../../../src/io/git/remote-origin.js";

export function giveConsent(config: ResolvedConfig, repoRoot: string): void {
  const repo = resolveRepo(repoRoot);
  if (repo === null) {
    throw new Error(
      `no 'origin' remote in ${repoRoot}: ${execFileSync("git", ["remote", "-v"], { cwd: repoRoot, encoding: "utf8" })}`,
    );
  }

  const db = openDb(config.paths.dbPath);
  try {
    markConsented(db, repo);
  } finally {
    db.close();
  }
}

/**
 * The repo as one that has been used before: past its bootstrap run.
 *
 * The first run in a repo gates everything to a person whatever its
 * confidence (06-review-and-pr.md, "The bootstrap run"), which is the right
 * default and the wrong starting point for a test about what the gate does
 * *afterwards* — under bootstrap every reason reads `bootstrap_run` and
 * nothing auto-publishes, so a contradiction cannot be told from an ordinary
 * addition. The developers these tests stand in for have run signposts before.
 */
export function markPastBootstrap(config: ResolvedConfig, repoRoot: string): void {
  const repo = resolveRepo(repoRoot);
  if (repo === null) {
    throw new Error(`no 'origin' remote in ${repoRoot}`);
  }

  const db = openDb(config.paths.dbPath);
  try {
    markBootstrapComplete(db, repo);
  } finally {
    db.close();
  }
}
