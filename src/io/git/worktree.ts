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

/** Where a branch this repository does not have yet should start from. */
function startPointFor(repoRoot: string, branch: string): string {
  return git(repoRoot, ["rev-parse", "--verify", `refs/remotes/origin/${branch}`]).ok
    ? `origin/${branch}`
    : baseBranch(repoRoot);
}

/**
 * Puts an existing worktree on `branch` when it is on something else.
 *
 * `branch` is derived, not fixed — `branchFor(config.git.branch_pattern,
 * authorEmail(repoRoot))` — so a repo-local `user.email` override, a new work
 * address, or an edited `branch_pattern` changes it while the worktree stays
 * checked out on the old one. Everything downstream then ran against the wrong
 * HEAD: the commit landed on the old branch, the push failed with "src refspec
 * does not match any", and the warning named a branch that had nothing on it.
 * Where `origin/<branch>` did exist, the reset in `refresh` moved the *old*
 * branch to the new branch's tip.
 */
function ensureOnBranch(repoRoot: string, worktreeDir: string, branch: string): GitResult {
  const head = git(worktreeDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (head.ok && head.output === branch) {
    return { ok: true, output: worktreeDir };
  }
  return git(worktreeDir, ["rev-parse", "--verify", `refs/heads/${branch}`]).ok
    ? git(worktreeDir, ["checkout", branch])
    : git(worktreeDir, ["checkout", "-b", branch, startPointFor(repoRoot, branch)]);
}

/**
 * A checkout of `repoRoot` at `worktreeDir`, on `branch`, created if absent.
 *
 * The branch is created from the remote copy where one exists, so a run on a
 * second machine — or after the state directory was cleared — continues the
 * developer's existing branch instead of starting a rival one from local HEAD.
 *
 * Every path ends in `refresh`, including the one that has just created the
 * worktree. `git worktree add <dir> <branch>` checks out `refs/heads/<branch>`
 * wherever it currently points, which is not necessarily where the remote has
 * it: clear `~/.signposts` on one machine after pushing from another and the
 * local ref is behind, so the worktree was built on a stale commit and every
 * push from then on was rejected non-fast-forward. `refresh` is already the
 * guarded catch-up, so it does that job here too rather than a second copy of
 * it living on this arm.
 *
 * The absent case prunes first. Whether the worktree exists is asked of the
 * directory, but git records it in the *parent* repository
 * (`.git/worktrees/<name>`), and that record outlives the directory — git does
 * not prune on its own. So a developer who clears `~/.signposts`, or moves
 * machine, hits a directory that is gone and a registration that is not:
 * `worktree add` refuses it as "a missing but already registered worktree",
 * and `worktree add -b` refuses the branch as one that already exists. Both
 * arms of the ternary below fail, `apply` reports that it could not prepare
 * the worktree, and it fails the same way on every later run — after every
 * model call in the session has already been paid for.
 */
export function ensureWorktree(input: {
  repoRoot: string;
  worktreeDir: string;
  branch: string;
  /**
   * Paths the caller rewrites from scratch on every commit. A conflict in one
   * of them is not a disagreement — see `reconcile`.
   */
  regenerated?: readonly string[];
}): GitResult {
  const { repoRoot, worktreeDir, branch } = input;
  const regenerated = input.regenerated ?? [];

  // One fetch for the whole operation. A worktree shares its parent's object
  // store and refs, so fetching here is what every step below reads. Offline
  // is not fatal: it is the ordinary reason a previous push failed, and the
  // worktree as it stands is still the right place to commit.
  const fetched = git(repoRoot, ["fetch", "origin", branch]).ok;

  if (existsSync(path.join(worktreeDir, ".git"))) {
    const onBranch = ensureOnBranch(repoRoot, worktreeDir, branch);
    return onBranch.ok ? refresh(worktreeDir, branch, fetched, regenerated) : onBranch;
  }

  mkdirSync(path.dirname(worktreeDir), { recursive: true });
  git(repoRoot, ["worktree", "prune"]);

  const existingBranch = git(repoRoot, ["rev-parse", "--verify", `refs/heads/${branch}`]).ok;
  const args = existingBranch
    ? ["worktree", "add", worktreeDir, branch]
    : ["worktree", "add", "-b", branch, worktreeDir, startPointFor(repoRoot, branch)];

  const added = git(repoRoot, args);
  return added.ok ? refresh(worktreeDir, branch, fetched, regenerated) : added;
}

/**
 * Brings a worktree up to date with the branch as the remote has it, so a
 * commit lands on top of what is in the pull request rather than forking from
 * a stale local copy.
 *
 * The reset only happens when the local branch is an ancestor of the remote
 * one — when everything here is already pushed. Otherwise it would discard a
 * commit whose push failed, which is precisely the case the commit port keeps
 * on purpose ("wrote N file(s) but could not push"): the extraction is the
 * expensive part, and it would be lost silently, on a later run, with nothing
 * said. Unpushed work is left where it is and the next commit stacks on it.
 *
 * A fetch that did not happen is not fatal either, for the same reason.
 *
 * Diverged is the third case, and it used to be a dead end. A commit whose
 * push failed leaves HEAD ahead; the remote then moves — the same developer's
 * other machine, or a merge — and HEAD stops being an ancestor. The reset was
 * declined (rightly: it would discard the unpushed commit), so every later run
 * added another commit to a branch whose push was already rejected, for ever,
 * with only the push warning to show for it. Rebasing keeps the local commits
 * and puts them on top of what the remote has, which is what makes the next
 * push land.
 */
function refresh(
  worktreeDir: string,
  branch: string,
  fetched: boolean,
  regenerated: readonly string[],
): GitResult {
  const remoteRef = `origin/${branch}`;

  if (!fetched) {
    return { ok: true, output: worktreeDir };
  }
  if (!git(worktreeDir, ["rev-parse", "--verify", remoteRef]).ok) {
    // The branch exists only here — nothing to catch up with.
    return { ok: true, output: worktreeDir };
  }
  if (git(worktreeDir, ["merge-base", "--is-ancestor", "HEAD", remoteRef]).ok) {
    const reset = git(worktreeDir, ["reset", "--hard", remoteRef]);
    return reset.ok ? { ok: true, output: worktreeDir } : reset;
  }
  if (git(worktreeDir, ["merge-base", "--is-ancestor", remoteRef, "HEAD"]).ok) {
    // Ahead of the remote and nothing to replay — an unpushed commit from a
    // previous run. The next push carries it.
    return { ok: true, output: worktreeDir };
  }

  return reconcile(worktreeDir, remoteRef, regenerated);
}

/**
 * Replays the local commits on top of the remote branch.
 *
 * A conflict confined to `regenerated` is resolved rather than abandoned. The
 * index is rewritten from the whole corpus on every commit, so both sides
 * having "changed" it is an artefact of that, not two people disagreeing about
 * anything — and whichever side wins here is overwritten by the write that
 * follows this call. A conflict in a signpost itself is a real disagreement
 * about a claim and is left to a person.
 *
 * A rebase that cannot be finished is unwound, and this still reports `ok`:
 * the extraction is already paid for, the commit is still worth making
 * locally, and the push warning tells the developer where it stands. Failing
 * here instead would throw away the session on top of everything else.
 */
function reconcile(
  worktreeDir: string,
  remoteRef: string,
  regenerated: readonly string[],
): GitResult {
  if (git(worktreeDir, ["rebase", remoteRef]).ok) {
    return { ok: true, output: worktreeDir };
  }

  const conflicted = git(worktreeDir, ["diff", "--name-only", "--diff-filter=U"]);
  const paths = conflicted.output.split("\n").filter((line) => line !== "");
  const onlyRegenerated =
    conflicted.ok && paths.length > 0 && paths.every((file) => regenerated.includes(file));

  if (onlyRegenerated) {
    git(worktreeDir, ["checkout", "--ours", "--", ...paths]);
    git(worktreeDir, ["add", "--", ...paths]);
    // GIT_EDITOR=true: `rebase --continue` opens an editor for the commit
    // message otherwise, and nothing here can answer it.
    if (git(worktreeDir, ["-c", "core.editor=true", "rebase", "--continue"]).ok) {
      return { ok: true, output: worktreeDir };
    }
  }

  git(worktreeDir, ["rebase", "--abort"]);
  return { ok: true, output: worktreeDir };
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

/** The branch the worktree has checked out, or null when there is no worktree. */
export function worktreeBranch(worktreeDir: string): string | null {
  if (!existsSync(path.join(worktreeDir, ".git"))) {
    return null;
  }
  const head = git(worktreeDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return head.ok && head.output !== "HEAD" ? head.output : null;
}

/** Whether `branch` has ever been pushed, as far as this clone's remote-tracking refs know. */
export function wasPushed(repoRoot: string, branch: string): boolean {
  return git(repoRoot, ["rev-parse", "--verify", `refs/remotes/origin/${branch}`]).ok;
}

/**
 * The full messages of the worktree's commits that the remote does not have,
 * oldest first.
 *
 * Measured against `origin/<branch>` once the branch has been pushed, and
 * against the base before that, since everything past the base is then this
 * developer's and unpushed.
 */
export function unpushedMessages(repoRoot: string, worktreeDir: string, branch: string): string[] {
  const upstream = wasPushed(repoRoot, branch) ? `origin/${branch}` : baseRef(repoRoot);
  const log = git(worktreeDir, ["log", "--reverse", "--format=%B%x00", `${upstream}..HEAD`]);
  if (!log.ok) {
    return [];
  }
  return log.output
    .split("\0")
    .map((message) => message.trim())
    .filter((message) => message !== "");
}

/** The base branch as a ref: the remote's copy where there is one. */
function baseRef(repoRoot: string): string {
  const base = baseBranch(repoRoot);
  return git(repoRoot, ["rev-parse", "--verify", `refs/remotes/origin/${base}`]).ok ? `origin/${base}` : base;
}
