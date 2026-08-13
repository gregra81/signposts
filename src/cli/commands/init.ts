// `signpost init` (R3): run first-run consent, and only on accept create
// `.signposts/` and append the CLAUDE.md pointer (idempotent). Consent is
// asked before anything is written — a decline must leave no trace, per
// consentExitCode's contract and the message this prints on decline. Thin
// orchestration only — every decision (already-initialised? accepted?
// what does the pointer become?) is src/core/init/policy.ts; this module
// gathers/writes.

import { existsSync } from "node:fs";
import type { ExitCode, Stdio } from "../../app.ts";
import type { ResolvedConfig } from "../../core/config/resolve.ts";
import {
  consentExitCode,
  ensureClaudeMdPointer,
  isConsented,
  needsConsentPrompt,
  parseConsentAnswer,
} from "../../core/init/policy.ts";
import { readClaudeMd, writeClaudeMd } from "../../io/init/claude-md.ts";
import { promptForConsent } from "../../io/init/consent-prompt.ts";
import { ensureKnowledgeDir } from "../../io/init/signposts-dir.ts";
import { openDb } from "../../io/db/migrate.ts";
import { hasConsented, markConsented } from "../../io/db/repo-state.ts";
import { resolveRepo } from "../../io/git/remote-origin.ts";

export interface RunInitInput {
  config: ResolvedConfig;
  repoRoot: string;
  stdio: Stdio;
}

export async function runInit({ config, repoRoot, stdio }: RunInitInput): Promise<ExitCode> {
  // `repo` (the repo_state key) comes from the `origin` git remote — this is
  // the one command besides `index` that needs it, so it's resolved here
  // rather than eagerly at the composition root (see src/io/production-app.ts):
  // a repo with no GitHub origin must fail gracefully, not crash bin/signpost.js.
  const repo = resolveRepo(repoRoot);
  if (repo === null) {
    stdio.error.write(
      "signposts: could not determine repo (owner/name) from the 'origin' git remote — is this a git repo with a GitHub origin configured?\n",
    );
    return 1;
  }

  // Don't create/migrate the db just to check consent — a decline must leave
  // no trace, and openDb() creates the file. Absent file ⇒ not consented.
  const dbFileExists = existsSync(config.paths.dbPath);
  const rowConsented =
    dbFileExists &&
    (() => {
      const db = openDb(config.paths.dbPath);
      try {
        return hasConsented(db, repo);
      } finally {
        db.close();
      }
    })();
  const alreadyConsented = isConsented(dbFileExists, rowConsented);

  if (!needsConsentPrompt(alreadyConsented)) {
    stdio.output.write("signposts: already initialised for this repo.\n");
    return 0;
  }

  const rawAnswer = await promptForConsent(stdio);
  const accepted = parseConsentAnswer(rawAnswer);

  if (accepted) {
    ensureKnowledgeDir(config.paths.knowledgeDir);

    const { content, changed } = ensureClaudeMdPointer(readClaudeMd(repoRoot));
    if (changed) {
      writeClaudeMd(repoRoot, content);
    }

    const db = openDb(config.paths.dbPath);
    try {
      markConsented(db, repo);
    } finally {
      db.close();
    }
    stdio.output.write("signposts: initialised.\n");
  } else {
    stdio.output.write("signposts: consent declined — nothing persisted.\n");
  }

  return consentExitCode(accepted);
}
