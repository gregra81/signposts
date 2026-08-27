// `git remote get-url origin` via a real subprocess — same pattern as
// src/io/doctor/gh-auth.ts's `gh auth status`. Degrades to `null` when
// there's no `origin` remote (or `git` itself can't be spawned); the caller
// decides what that means.

import { spawnSync } from "node:child_process";
import { deriveOwnerRepo } from "../../core/git/owner-repo.ts";

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
 * doesn't parse. Only `init`/`index` call this — `doctor` never needs a
 * repo key (R5), so it must stay free of any GitHub-origin requirement.
 */
export function resolveRepo(repoRoot: string): string | null {
  const originUrl = getOriginUrl(repoRoot);
  return originUrl === null ? null : deriveOwnerRepo(originUrl);
}
