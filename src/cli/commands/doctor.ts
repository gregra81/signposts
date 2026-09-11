// `signpost doctor` (R5): gathers raw facts about this machine (node version,
// git author and origin, `gh` auth, embedding cache, database, hook) and
// prints the report
// src/core/doctor/report.ts builds from them. Always exits 0 — this is a
// diagnostic report, not a pass/fail gate.
//
// Every fact here is measured, not assumed: 07-triggering-and-ux.md asks
// doctor to "turn a bug report into a self-diagnosis", and a check that
// reports what ought to be true is worse than no check, because it is the
// answer the developer trusts before opening the issue.

import path from "node:path";
import type { ExitCode } from "../../app.ts";
import type { ResolvedConfig } from "../../core/config/resolve.ts";
import { EMBEDDING_MODEL, NODE_MIN_VERSION } from "../../core/config/constants.ts";
import { buildDoctorReport, type DoctorFacts } from "../../core/doctor/report.ts";
import { checkGhAuth } from "../../io/doctor/gh-auth.ts";
import { checkModelCache } from "../../io/doctor/model-cache.ts";
import { checkDbIntegrity } from "../../io/doctor/db-integrity.ts";
import { checkSessionStartHookInstalled } from "../../io/doctor/hook-settings.ts";
import { checkGitFacts } from "../../io/doctor/git-facts.ts";

export interface RunDoctorInput {
  config: ResolvedConfig;
  repoRoot: string;
  stdout: NodeJS.WritableStream;
}

function currentNodeMajorVersion(): number {
  return Number(process.versions.node.split(".")[0]);
}

export function runDoctor({ config, repoRoot, stdout }: RunDoctorInput): ExitCode {
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
    git: checkGitFacts(repoRoot),
    // `path.dirname(transcriptRoot)` is Claude Code's config directory, the
    // same derivation `init` uses — `CLAUDE_CONFIG_DIR` moves it, and reading
    // the environment here would be R7.
    hook: checkSessionStartHookInstalled(repoRoot, path.dirname(config.paths.transcriptRoot)),
  };

  for (const line of buildDoctorReport(facts)) {
    stdout.write(`${line}\n`);
  }

  return 0;
}
