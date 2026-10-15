// `git remote get-url origin` via a real subprocess — same pattern as
// src/io/doctor/gh-auth.ts's `gh auth status`. Degrades to `null` when
// there's no `origin` remote (or `git` itself can't be spawned); the caller
// decides what that means.

import { spawnSync } from "node:child_process";
import { STORAGE, STORAGE_PERSONAL } from "../../core/config/constants.ts";
import { deriveOwnerRepo, localRepoKey } from "../../core/git/owner-repo.ts";

export function getOriginUrl(repoRoot: string): string | null {
  const result = spawnSync("git", ["remote", "get-url", "origin"], { cwd: repoRoot, encoding: "utf8" });

  if (result.error || result.status !== 0) {
    return null;
  }

  return result.stdout.trim();
}

/**
 * The `"owner/name"` repo key (12-wire-contracts.md) derived from
 * `repoRoot`'s `origin` git remote, or `null` when there's no origin or it
 * doesn't parse. `init` and `index` need it and refuse to run without it;
 * `doctor` only reports it (18-end-to-end-gaps.md item 7), so this must stay
 * free of any GitHub-origin requirement — `doctor` runs in any repo (R5).
 *
 * Under personal storage a repo with no such origin gets `localRepoKey`
 * instead: a branch and a pull request are what need the remote, and that
 * route has neither.
 */
export function resolveRepo(repoRoot: string, storage: string = STORAGE): string | null {
  const originUrl = getOriginUrl(repoRoot);
  const fromOrigin = originUrl === null ? null : deriveOwnerRepo(originUrl);
  return fromOrigin ?? (storage === STORAGE_PERSONAL ? localRepoKey(repoRoot) : null);
}
