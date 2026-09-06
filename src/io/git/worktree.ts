// Git, through a second checkout.
//
// A run happens while the developer is working in the repository, so nothing
// here may touch their checkout: no branch switch, no file appearing in their
// working tree, no index they did not stage. Everything a commit needs
// happens in a worktree of the same repository (`paths.worktreeDir`), on the
// signposts branch, which nothing else uses.
//
// The worktree is created once and reused. It is also the only place the
// branch exists locally, which is what makes "one long-lived branch per
// developer" (06-review-and-pr.md) safe to reuse across runs: a session three
// days later adds a commit to the same checkout, on the same branch, with the
// developer's own tree untouched throughout.
//
// Failures are reported, never thrown past the caller as a stack: the
// extraction is the expensive part and it is already done by the time
// anything here runs.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import path from "node:path";

export interface GitResult {
  ok: boolean;
  /** stdout on success, stderr on failure — whichever the caller can act on. */
  output: string;
}

function git(cwd: string, args: readonly string[]): GitResult {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) {
    return { ok: false, output: (result.stderr ?? result.error?.message ?? "").trim() };
  }
  return { ok: true, output: result.stdout.trim() };
}

/** `git config user.email` — the REAL address, written into provenance. */
export function authorEmail(repoRoot: string): string | null {
  const result = git(repoRoot, ["config", "user.email"]);
  return result.ok && result.output !== "" ? result.output : null;
}

/** The branch the repository's default remote HEAD points at, falling back to the current one. */
function baseBranch(repoRoot: string): string {
  const remote = git(repoRoot, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (remote.ok) {
    const name = remote.output.split("/").at(-1);
    if (name !== undefined && name !== "") {
      return name;
    }
  }
  return git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).output;
}

/**
 * A checkout of `repoRoot` at `worktreeDir`, on `branch`, created if absent.
 *
 * The branch is created from the remote copy where one exists, so a run on a
 * second machine — or after the state directory was cleared — continues the
 * developer's existing branch instead of starting a rival one from local HEAD.
 */
export function ensureWorktree(input: {
  repoRoot: string;
  worktreeDir: string;
  branch: string;
}): GitResult {
  const { repoRoot, worktreeDir, branch } = input;

  if (existsSync(path.join(worktreeDir, ".git"))) {
    return refresh(worktreeDir, branch);
  }

  mkdirSync(path.dirname(worktreeDir), { recursive: true });
  git(repoRoot, ["fetch", "origin", branch]);

  const startPoint = git(repoRoot, ["rev-parse", "--verify", `refs/remotes/origin/${branch}`]).ok
    ? `origin/${branch}`
    : baseBranch(repoRoot);

  const existingBranch = git(repoRoot, ["rev-parse", "--verify", `refs/heads/${branch}`]).ok;
  const args = existingBranch
    ? ["worktree", "add", worktreeDir, branch]
    : ["worktree", "add", "-b", branch, worktreeDir, startPoint];

  const added = git(repoRoot, args);
  return added.ok ? { ok: true, output: worktreeDir } : added;
}

/**
 * Brings an existing worktree up to date with the branch as the remote has
 * it, so a commit lands on top of what is in the pull request rather than
 * forking from a stale local copy.
 *
 * The reset only happens when the local branch is an ancestor of the remote
 * one — when everything here is already pushed. Otherwise it would discard a
 * commit whose push failed, which is precisely the case the commit port keeps
 * on purpose ("wrote N file(s) but could not push"): the extraction is the
 * expensive part, and it would be lost silently, on a later run, with nothing
 * said. Unpushed work is left where it is and the next commit stacks on it.
 *
 * A fetch that fails is not fatal either — offline is the ordinary reason a
 * push failed in the first place, and the worktree as it stands is still the
 * right place to commit.
 */
function refresh(worktreeDir: string, branch: string): GitResult {
  const remoteRef = `origin/${branch}`;

  const fetched = git(worktreeDir, ["fetch", "origin", branch]);
  if (!fetched.ok) {
    return { ok: true, output: worktreeDir };
  }
  if (!git(worktreeDir, ["rev-parse", "--verify", remoteRef]).ok) {
    // The branch exists only here — nothing to catch up with.
    return { ok: true, output: worktreeDir };
  }
  if (!git(worktreeDir, ["merge-base", "--is-ancestor", "HEAD", remoteRef]).ok) {
    return { ok: true, output: worktreeDir };
  }

  const reset = git(worktreeDir, ["reset", "--hard", remoteRef]);
  return reset.ok ? { ok: true, output: worktreeDir } : reset;
}

/**
 * Stages `paths` and commits them. `ok` with an empty output means there was
 * nothing to commit — the same operations applied twice, which is not a
 * failure.
 */
export function commitAll(input: {
  worktreeDir: string;
  paths: readonly string[];
  message: string;
}): GitResult {
  const { worktreeDir, paths, message } = input;
  if (paths.length === 0) {
    return { ok: true, output: "" };
  }

  const staged = git(worktreeDir, ["add", "--", ...paths]);
  if (!staged.ok) {
    return staged;
  }
  if (git(worktreeDir, ["diff", "--cached", "--quiet"]).ok) {
    return { ok: true, output: "" };
  }
  return git(worktreeDir, ["commit", "-m", message]);
}

export function push(worktreeDir: string, branch: string): GitResult {
  return git(worktreeDir, ["push", "--set-upstream", "origin", branch]);
}
