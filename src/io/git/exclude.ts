// Keeps a machine-local file out of git through `.git/info/exclude`, the
// repo's own ignore list that is never committed.
//
// For `.claude/settings.local.json`, which `init` writes with an absolute path
// to this machine's install. Claude Code keeps that file out of commits itself,
// but only the first time *it* writes the file; one written by another tool is
// the developer's to ignore, and in the cold walkthrough nothing did, so a
// `git add -A` would have committed it (19-value-to-a-user.md, open item 18).
// Not the team's `.gitignore` — that is a shared file, and this is one
// person's install — and not the global excludes file, which is outside the
// repo.

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

/** True when this call added the exclude; false when git already ignored it or could not be asked. */
export function excludeFromGit(repoRoot: string, relative: string): boolean {
  const ignored = spawnSync("git", ["check-ignore", "-q", "--", relative], { cwd: repoRoot });
  if (ignored.error || ignored.status !== 1) {
    // 0 is already ignored; anything else is git failing, and a best-effort
    // ignore is not worth failing `init` over.
    return false;
  }
  // `--git-path`, not `.git/info/exclude`: in a linked worktree `.git` is a file.
  const where = spawnSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: repoRoot, encoding: "utf8" });
  if (where.error || where.status !== 0) {
    return false;
  }
  const file = path.resolve(repoRoot, where.stdout.trim());
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `\n${relative}\n`, "utf8");
  } catch {
    return false;
  }
  return true;
}
