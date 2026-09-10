// The consent gate the three token-spending commands pass through.
//
// `init` is where consent is asked, and until now it was also the only place
// it was ever read — so `signpost run` in a repo that had never seen `init`
// went straight to the model calls. That is the failure story 70 is written
// against: unexplained spend must never be how a developer finds out the tool
// is running, and a gate only one entry point honours is not a gate. Both
// paths reach the same persisted row, so consenting once through `init`
// covers the skill-driven loop and the manual CLI alike.
//
// `sessions`, `index` and `worker` are deliberately not gated: listing
// transcripts, indexing and the census are local, free, and spend no tokens
// (05-retrieval.md, "reindexing is local and free: no model call, no
// consent"). A reader who only consumes knowledge never has to answer
// anything.

import type { ResolvedConfig } from "../core/config/resolve.ts";
import { CONSENT_REQUIRED_MESSAGE } from "../core/init/policy.ts";
import { readConsent } from "../io/init/consent-state.ts";
import { resolveRepo } from "../io/git/remote-origin.ts";
import { fail } from "./with-run.ts";

export interface ConsentGateInput {
  config: ResolvedConfig;
  repoRoot: string;
  stderr: NodeJS.WritableStream;
}

/**
 * True when this repo may spend tokens. Anything else has already been
 * reported on stderr.
 *
 * A repo whose `origin` yields no `owner/name` has no consent key at all, and
 * this defers rather than refusing: `openRun` turns the same repo away a
 * moment later, naming the missing origin, which is the thing the developer
 * has to fix. Nothing is spent in between — a run that cannot identify its
 * repo never reaches a model call.
 */
export function hasConsent({ config, repoRoot, stderr }: ConsentGateInput): boolean {
  const repo = resolveRepo(repoRoot);
  if (repo === null) {
    return true;
  }

  let consented: boolean;
  try {
    consented = readConsent(config.paths.dbPath, repo);
  } catch {
    // A database that exists and cannot be read is `doctor`'s story to tell
    // (it runs `PRAGMA integrity_check`); here it is simply not a consent.
    fail(stderr, `database at ${config.paths.dbPath} is corrupt or unreadable — run \`signpost doctor\`.`);
    return false;
  }

  if (!consented) {
    fail(stderr, CONSENT_REQUIRED_MESSAGE);
    return false;
  }
  return true;
}
