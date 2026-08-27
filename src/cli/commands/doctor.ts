// `signpost doctor` (R5): gathers raw facts (node version, credential
// availability, `gh` auth, cache/db/hook presence) and prints the report
// src/core/doctor/report.ts builds from them. Always exits 0 — this is a
// diagnostic report, not a pass/fail gate.

import type { ExitCode } from "../../app.ts";
import type { ResolvedConfig } from "../../core/config/resolve.ts";
import { NODE_MIN_VERSION } from "../../core/config/constants.ts";
import { buildDoctorReport, type CredentialFact, type DoctorFacts } from "../../core/doctor/report.ts";
import { checkGhAuth } from "../../io/doctor/gh-auth.ts";
import { checkModelCachePresent } from "../../io/doctor/model-cache.ts";
import { checkDbIntegrity } from "../../io/doctor/db-integrity.ts";
import { checkSessionStartHookInstalled } from "../../io/doctor/hook-settings.ts";

export interface RunDoctorInput {
  config: ResolvedConfig;
  repoRoot: string;
  /**
   * Credential presence, resolved once at the composition root. Carries which
   * methods are available and which one wins — never a token value.
   */
  credentials: CredentialFact;
  stdout: NodeJS.WritableStream;
}

function currentNodeMajorVersion(): number {
  return Number(process.versions.node.split(".")[0]);
}

export function runDoctor({ config, repoRoot, credentials, stdout }: RunDoctorInput): ExitCode {
  const facts: DoctorFacts = {
    nodeMajorVersion: currentNodeMajorVersion(),
    nodeMinVersion: NODE_MIN_VERSION,
    credential: credentials,
    gh: checkGhAuth(),
    modelCachePresent: checkModelCachePresent(config.paths.modelCacheDir),
    dbIntegrity: checkDbIntegrity(config.paths.dbPath),
    hookInstalled: checkSessionStartHookInstalled(repoRoot),
  };

  for (const line of buildDoctorReport(facts)) {
    stdout.write(`${line}\n`);
  }

  return 0;
}
