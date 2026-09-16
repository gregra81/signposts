// `signpost doctor` (R5): gathers raw facts about this machine (node version,
// git author and origin, `gh` auth, embedding cache, database, hook, consent,
// status line, the background worker's last error) and prints the report
// src/core/doctor/report.ts builds from them.
//
// Exits 1 when something on it blocks `signpost run`, 0 otherwise. It used to
// exit 0 always, as a report rather than a gate — which told a script, and
// anyone reading `$?`, that a repo with no origin was fine
// (19-value-to-a-user.md item 4). Every line is still printed either way.
//
// Every fact here is measured, not assumed: 07-triggering-and-ux.md asks
// doctor to "turn a bug report into a self-diagnosis", and a check that
// reports what ought to be true is worse than no check, because it is the
// answer the developer trusts before opening the issue.

import path from "node:path";
import type { ExitCode } from "../../app.ts";
import type { ResolvedConfig } from "../../core/config/resolve.ts";
import { EMBEDDING_MODEL, NODE_MIN_VERSION } from "../../core/config/constants.ts";
import { blockers, buildDoctorReport, type DoctorFacts } from "../../core/doctor/report.ts";
import { checkGhAuth } from "../../io/doctor/gh-auth.ts";
import { checkModelCache } from "../../io/doctor/model-cache.ts";
import { checkDbIntegrity } from "../../io/doctor/db-integrity.ts";
import { checkSessionStartHookInstalled } from "../../io/doctor/hook-settings.ts";
import { checkGitFacts } from "../../io/doctor/git-facts.ts";
import { checkConsent } from "../../io/doctor/consent.ts";
import { checkStatusLine } from "../../io/doctor/statusline.ts";
import { readStatus } from "../../io/worker/status-file.ts";
import { EXIT_CODES } from "../../core/cli/exit-codes.ts";

export interface RunDoctorInput {
  config: ResolvedConfig;
  repoRoot: string;
  stdout: NodeJS.WritableStream;
}

function currentNodeMajorVersion(): number {
  return Number(process.versions.node.split(".")[0]);
}

export function runDoctor({ config, repoRoot, stdout }: RunDoctorInput): ExitCode {
  const git = checkGitFacts(repoRoot);
  const facts: DoctorFacts = {
    nodeMajorVersion: currentNodeMajorVersion(),
    nodeMinVersion: NODE_MIN_VERSION,
    gh: checkGhAuth(),
    modelCache: checkModelCache({
      modelCacheDir: config.paths.modelCacheDir,
      embeddingModel: EMBEDDING_MODEL,
      localModelPath: config.retrieval.local_model_path,
      allowRemoteModels: config.retrieval.allow_remote_models,
    }),
    dbIntegrity: checkDbIntegrity(config.paths.dbPath),
    git,
    // `path.dirname(transcriptRoot)` is Claude Code's config directory, the
    // same derivation `init` uses — `CLAUDE_CONFIG_DIR` moves it, and reading
    // the environment here would be R7.
    hook: checkSessionStartHookInstalled(repoRoot, path.dirname(config.paths.transcriptRoot)),
    consent: checkConsent(config.paths.dbPath, git.repo),
    statusLine: checkStatusLine(repoRoot),
    lastError: readStatus(config.paths.statuslineState)?.lastError ?? null,
  };

  for (const line of buildDoctorReport(facts)) {
    stdout.write(`${line}\n`);
  }

  return blockers(facts).length === 0 ? EXIT_CODES.ok : EXIT_CODES.failure;
}
