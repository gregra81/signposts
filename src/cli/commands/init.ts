// `signpost init` (R3): run first-run consent, and only on accept create
// `.signposts/`, install the skill and append the CLAUDE.md pointer
// (idempotent). Consent is
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
import { writeSkill } from "../../io/init/skill-file.ts";
import { installStatusLine } from "../../io/init/statusline-file.ts";
import { STATUSLINE_OUTCOMES } from "../../core/init/statusline-settings.ts";
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
  let rowConsented: boolean;
  try {
    rowConsented =
      dbFileExists &&
      (() => {
        const db = openDb(config.paths.dbPath);
        try {
          return hasConsented(db, repo);
        } finally {
          db.close();
        }
      })();
  } catch {
    stdio.error.write(`signposts: database at ${config.paths.dbPath} is corrupt or unreadable.\n`);
    return 1;
  }
  const alreadyConsented = isConsented(dbFileExists, rowConsented);

  if (!needsConsentPrompt(alreadyConsented)) {
    // Rewrite the skill on the way out. `init` is the only thing that writes
    // it, and CLAUDE.md, the PR prose and skill-file.ts all promise it is
    // rewritten on every accepted init "so it cannot drift from the CLI it
    // describes" — which was not true of the second init onwards, the only
    // kind that happens after an upgrade. A repo that consented a year ago
    // was still being driven by the SKILL.md of whatever build ran first.
    //
    // It is safe here for the reason the guarantee is worth having: consent
    // has already been given, and the skill is a repo-local file this command
    // owns, not state a decline could leave behind.
    const rewritten = writeSkill(repoRoot);
    stdio.output.write(
      `signposts: already initialised for this repo. Refreshed ${rewritten}.\n`,
    );
    // Same reason as the skill: the settings entry names the path this build
    // installed to, and an upgrade moves it.
    reportStatusLine(stdio, installStatusLine(repoRoot));
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

    // The skill is how signposts is used: it drives the CLI from inside a
    // Claude Code session, which is where the reasoning happens.
    const skillPath = writeSkill(repoRoot);

    try {
      const db = openDb(config.paths.dbPath);
      try {
        markConsented(db, repo);
      } finally {
        db.close();
      }
    } catch {
      stdio.error.write(`signposts: database at ${config.paths.dbPath} is corrupt or unreadable.\n`);
      return 1;
    }
    stdio.output.write(`signposts: initialised. Wrote ${skillPath} — ask Claude to run signposts.\n`);
    reportStatusLine(stdio, installStatusLine(repoRoot));
  } else {
    stdio.output.write("signposts: consent declined — nothing persisted.\n");
  }

  return consentExitCode(accepted);
}

/**
 * Says what happened to the status line, because something did.
 *
 * A tool that edits a settings file and says nothing is one the developer
 * finds out about when their own status line looks different — so the wrapped
 * command is named back to them, and so is the file to delete it from.
 */
function reportStatusLine(stdio: Stdio, install: ReturnType<typeof installStatusLine>): void {
  if (install === null) {
    return; // Unparseable or unwritable settings — left alone, and not `init`'s to fail over.
  }
  if (install.outcome === STATUSLINE_OUTCOMES.wrapped && install.wrapped !== undefined) {
    stdio.output.write(
      `signposts: status line added to ${install.file}, wrapping the one you had (${install.wrapped}).\n`,
    );
    return;
  }
  if (install.outcome === STATUSLINE_OUTCOMES.installed) {
    stdio.output.write(`signposts: status line installed in ${install.file}.\n`);
  }
}
