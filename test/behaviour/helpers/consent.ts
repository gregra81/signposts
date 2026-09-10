// Consent, as `signpost init` persists it (R3).
//
// `run`, `resume` and `review` refuse to spend tokens in a repo that has
// never consented (src/cli/consent.ts), so a behaviour test that drives the
// loop has to have consented first — the same as the developer it stands in
// for. It writes the row rather than driving `init`, because `init` also
// creates `.signposts/`, the CLAUDE.md pointer, the skill and the status line,
// and none of that is what these tests are about.

import { execFileSync } from "node:child_process";
import type { ResolvedConfig } from "../../../src/core/config/resolve.js";
import { openDb } from "../../../src/io/db/migrate.js";
import { markConsented } from "../../../src/io/db/repo-state.js";
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
