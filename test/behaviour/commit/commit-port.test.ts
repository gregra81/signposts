// The write path, against real git: a bare remote, a clone the "developer"
// is working in, and the worktree signposts commits through.
//
// Real git rather than a fake because the properties worth having are git's:
// the developer's checkout is untouched, two sessions land as two commits on
// one branch, and the branch survives being pushed and re-fetched. A fake
// that returned "ok" would assert none of that.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeCommitPort } from "../../../src/io/commit/commit-port.js";
import { FakeForge } from "../../../src/io/forge/fake-forge.js";
import { BRANCH_PATTERN, SIGNPOSTS_DIRNAME } from "../../../src/core/config/constants.js";
import { parseSignpost, serialiseSignpost } from "../../../src/core/signpost/codec.js";
import type { Operation } from "../../../src/core/contracts/graph.js";
import type { Signpost } from "../../../src/core/signpost/schema.js";

const AUTHOR = "greg@example.com";
const BRANCH = "signposts/greg";
const TODAY = "2026-09-05";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function signpost(overrides: Partial<Signpost> = {}): Signpost {
  return {
    id: "staging-read-only",
    claim: "Staging is read only outside the ETL window",
    category: "environment",
    scope: { repo: "acme/api" },
    evidence: "A migration failed with a permissions error.",
    confidence: 0.9,
    provenance: {
      session_ids: ["sess-1"],
      authors: [AUTHOR],
      first_seen: "2026-01-01",
      last_reinforced: "2026-01-01",
    },
    status: "active",
    ...overrides,
  };
}

describe("the commit port", () => {
  let root: string;
  let remote: string;
  let repoRoot: string;
  let worktreeDir: string;
  let forge: FakeForge;
  let warnings: string[];

  function port() {
    return makeCommitPort({
      repoRoot,
      worktreeDir,
      branchPattern: BRANCH_PATTERN,
      author: AUTHOR,
      forge,
      warn: (message) => warnings.push(message),
      today: () => TODAY,
    });
  }

  function apply(sessionId: string, operations: Operation[]) {
    return port().apply({ repo: "acme/api", repoRoot, sessionId, operations });
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "signposts-commit-"));
    remote = path.join(root, "remote.git");
    repoRoot = path.join(root, "checkout");
    worktreeDir = path.join(root, "state", "pr-worktree");
    forge = new FakeForge();
    warnings = [];

    execFileSync("git", ["init", "--bare", "--initial-branch=main", remote]);
    execFileSync("git", ["clone", remote, repoRoot]);
    git(repoRoot, "config", "user.email", AUTHOR);
    git(repoRoot, "config", "user.name", "Greg");
    // The developer's own gitconfig may sign commits; a temp repo in a test
    // has no key and no agent to reach.
    git(repoRoot, "config", "commit.gpgsign", "false");
    writeFileSync(path.join(repoRoot, "README.md"), "# work in progress\n", "utf8");
    git(repoRoot, "add", "README.md");
    git(repoRoot, "commit", "-m", "initial");
    git(repoRoot, "push", "-u", "origin", "main");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("writes the signpost, the index and a commit onto the developer's branch", async () => {
    await apply("sess-1", [{ op: "add", signpost: signpost() }]);

    const written = path.join(worktreeDir, SIGNPOSTS_DIRNAME, "environment", "staging-read-only.md");
    expect(parseSignpost(readFileSync(written, "utf8"))).toEqual(signpost());
    expect(readFileSync(path.join(worktreeDir, SIGNPOSTS_DIRNAME, "index.md"), "utf8")).toContain(
      "staging-read-only",
    );
    expect(git(worktreeDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe(BRANCH);
    expect(git(worktreeDir, "log", "-1", "--pretty=%s")).toBe("signposts: 1 from session sess-1");
  });

  it("leaves the checkout the developer is working in exactly as it was", async () => {
    const before = git(repoRoot, "rev-parse", "HEAD");

    await apply("sess-1", [{ op: "add", signpost: signpost() }]);

    expect(git(repoRoot, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(repoRoot, "rev-parse", "HEAD")).toBe(before);
    expect(git(repoRoot, "status", "--porcelain")).toBe("");
    expect(existsSync(path.join(repoRoot, SIGNPOSTS_DIRNAME))).toBe(false);
  });

  it("pushes the branch to the remote", async () => {
    await apply("sess-1", [{ op: "add", signpost: signpost() }]);

    expect(git(remote, "rev-parse", "--verify", BRANCH)).toBe(git(worktreeDir, "rev-parse", "HEAD"));
    expect(warnings).toEqual([]);
  });

  it("opens one PR and updates it on the next session, rather than opening a second", async () => {
    await apply("sess-1", [{ op: "add", signpost: signpost() }]);
    await apply("sess-2", [
      { op: "reinforce", id: "staging-read-only", sessionId: "sess-2", author: AUTHOR },
    ]);

    expect(forge.openPrCalls).toHaveLength(1);
    expect(forge.openPrCalls[0]?.branch).toBe(BRANCH);
    expect(forge.updatePrCalls).toHaveLength(1);
    // Both sessions are visible to a reviewer, not just the last one.
    expect(forge.updatePrCalls[0]?.body).toContain("sess-1");
    expect(forge.updatePrCalls[0]?.body).toContain("sess-2");
  });

  it("adds one commit per session on the same branch", async () => {
    await apply("sess-1", [{ op: "add", signpost: signpost() }]);
    await apply("sess-2", [
      { op: "reinforce", id: "staging-read-only", sessionId: "sess-2", author: AUTHOR },
    ]);

    expect(git(worktreeDir, "log", "--pretty=%s", `main..${BRANCH}`).split("\n")).toEqual([
      "signposts: 1 from session sess-2",
      "signposts: 1 from session sess-1",
    ]);
    expect(parseSignpost(
      readFileSync(path.join(worktreeDir, SIGNPOSTS_DIRNAME, "environment", "staging-read-only.md"), "utf8"),
    ).provenance.session_ids).toEqual(["sess-1", "sess-2"]);
  });

  it("labels the PR, and says so when a claim was replaced", async () => {
    await apply("sess-1", [
      {
        op: "add",
        signpost: signpost(),
      },
    ]);
    await apply("sess-2", [
      {
        op: "supersede",
        id: "staging-read-only",
        replacement: signpost({ id: "staging-writable", claim: "Staging accepts writes in the window" }),
      },
    ]);

    expect(forge.setLabelsCalls.map((call) => call.labels)).toEqual([
      ["signposts"],
      ["signposts", "has-contradiction"],
    ]);
  });

  it("applies to what the branch already carries, not to the developer's working tree", async () => {
    // A signpost merged into main long ago, and one this branch proposed.
    await apply("sess-1", [{ op: "add", signpost: signpost() }]);
    mkdirSync(path.join(repoRoot, SIGNPOSTS_DIRNAME, "environment"), { recursive: true });
    writeFileSync(
      path.join(repoRoot, SIGNPOSTS_DIRNAME, "environment", "unrelated.md"),
      serialiseSignpost(signpost({ id: "unrelated", claim: "Something else entirely" })),
      "utf8",
    );

    await apply("sess-2", [
      { op: "reinforce", id: "staging-read-only", sessionId: "sess-2", author: AUTHOR },
    ]);

    expect(warnings).toEqual([]);
    expect(existsSync(path.join(worktreeDir, SIGNPOSTS_DIRNAME, "environment", "unrelated.md"))).toBe(
      false,
    );
  });

  it("keeps the push when the forge cannot be reached, and says how to finish by hand", async () => {
    const failing = makeCommitPort({
      repoRoot,
      worktreeDir,
      branchPattern: BRANCH_PATTERN,
      author: AUTHOR,
      forge: {
        hasOpenPr: () => Promise.reject(new Error("gh: not authenticated")),
        openPr: (input) => forge.openPr(input),
        readPrBody: (prNumber) => forge.readPrBody(prNumber),
        updatePr: (prNumber, body) => forge.updatePr(prNumber, body),
        setLabels: (prNumber, labels) => forge.setLabels(prNumber, labels),
      },
      warn: (message) => warnings.push(message),
      today: () => TODAY,
    });

    await failing.apply({
      repo: "acme/api",
      repoRoot,
      sessionId: "sess-1",
      operations: [{ op: "add", signpost: signpost() }],
    });

    expect(git(remote, "rev-parse", "--verify", BRANCH)).toBeTruthy();
    expect(warnings.join("\n")).toContain("gh pr create --head signposts/greg");
  });

  it("keeps a commit whose push failed, rather than resetting over it on the next run", async () => {
    // The push-failure path keeps the commit deliberately, on the grounds
    // that a lost extraction is gone. A later run that reset the worktree to
    // the remote branch would throw it away silently, one run after the
    // failure, with nothing said anywhere.
    await apply("sess-1", [{ op: "add", signpost: signpost() }]);

    git(repoRoot, "remote", "set-url", "origin", path.join(root, "no-such-remote.git"));
    await apply("sess-2", [
      { op: "reinforce", id: "staging-read-only", sessionId: "sess-2", author: AUTHOR },
    ]);
    expect(warnings.join("\n")).toContain("could not push");
    const unpushed = git(worktreeDir, "rev-parse", "HEAD");

    git(repoRoot, "remote", "set-url", "origin", remote);
    await apply("sess-3", [
      { op: "reinforce", id: "staging-read-only", sessionId: "sess-3", author: AUTHOR },
    ]);

    expect(git(worktreeDir, "log", "--pretty=%H")).toContain(unpushed);
    expect(git(worktreeDir, "log", "--pretty=%s", "-3").split("\n")).toEqual([
      "signposts: 1 from session sess-3",
      "signposts: 1 from session sess-2",
      "signposts: 1 from session sess-1",
    ]);
  });

  it("catches up with the branch when everything here is already pushed", async () => {
    // Someone merged, or a second machine pushed: the worktree has nothing of
    // its own, so it takes the remote's version rather than committing onto a
    // stale copy.
    await apply("sess-1", [{ op: "add", signpost: signpost() }]);

    const elsewhere = path.join(root, "elsewhere");
    execFileSync("git", ["clone", "--branch", BRANCH, remote, elsewhere]);
    git(elsewhere, "config", "user.email", AUTHOR);
    git(elsewhere, "config", "user.name", "Someone");
    git(elsewhere, "config", "commit.gpgsign", "false");
    writeFileSync(path.join(elsewhere, "NOTE.md"), "from another machine\n", "utf8");
    git(elsewhere, "add", "NOTE.md");
    git(elsewhere, "commit", "-m", "from another machine");
    git(elsewhere, "push");

    await apply("sess-2", [
      { op: "reinforce", id: "staging-read-only", sessionId: "sess-2", author: AUTHOR },
    ]);

    expect(git(worktreeDir, "log", "--pretty=%s", "-2").split("\n")).toEqual([
      "signposts: 1 from session sess-2",
      "from another machine",
    ]);
  });

  it("names the open pull request when it is the update that failed, not `gh pr create`", async () => {
    // Sending someone to open a pull request that is already open is either
    // an error or, on a fork, a second PR.
    await apply("sess-1", [{ op: "add", signpost: signpost() }]);

    const failingUpdate = makeCommitPort({
      repoRoot,
      worktreeDir,
      branchPattern: BRANCH_PATTERN,
      author: AUTHOR,
      forge: {
        hasOpenPr: (branch) => forge.hasOpenPr(branch),
        openPr: (input) => forge.openPr(input),
        readPrBody: (prNumber) => forge.readPrBody(prNumber),
        updatePr: () => Promise.reject(new Error("gh: label not found")),
        setLabels: (prNumber, labels) => forge.setLabels(prNumber, labels),
      },
      warn: (message) => warnings.push(message),
      today: () => TODAY,
    });

    await failingUpdate.apply({
      repo: "acme/api",
      repoRoot,
      sessionId: "sess-2",
      operations: [{ op: "reinforce", id: "staging-read-only", sessionId: "sess-2", author: AUTHOR }],
    });

    const warning = warnings.join("\n");
    expect(warning).toContain("pull request #1");
    expect(warning).not.toContain("gh pr create");
  });

  it("recovers a worktree whose directory was deleted but is still registered", async () => {
    await apply("sess-1", [{ op: "add", signpost: signpost() }]);
    // What clearing ~/.signposts looks like. Git keeps the registration in the
    // parent repo's .git/worktrees and does not prune on its own, so both
    // `worktree add` and `worktree add -b` refuse — permanently, until pruned.
    rmSync(worktreeDir, { recursive: true, force: true });

    await apply("sess-2", [
      { op: "reinforce", id: "staging-read-only", sessionId: "sess-2", author: AUTHOR },
    ]);

    expect(git(worktreeDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe(BRANCH);
    expect(warnings).toEqual([]);
  });

  it("catches a rebuilt worktree up to the remote instead of committing on a stale local ref", async () => {
    await apply("sess-1", [{ op: "add", signpost: signpost() }]);

    // Another machine pushes to the same branch, then this one loses its
    // worktree directory. `refs/heads/signposts/greg` survives here at the old
    // commit, so `worktree add <dir> <branch>` would check that out and every
    // push from then on would be rejected non-fast-forward.
    const elsewhere = path.join(root, "elsewhere");
    execFileSync("git", ["clone", "--branch", BRANCH, remote, elsewhere]);
    git(elsewhere, "config", "user.email", "someone@example.com");
    git(elsewhere, "config", "user.name", "Someone");
    git(elsewhere, "config", "commit.gpgsign", "false");
    writeFileSync(path.join(elsewhere, "other.md"), "from another machine\n", "utf8");
    git(elsewhere, "add", "other.md");
    git(elsewhere, "commit", "-m", "from another machine");
    git(elsewhere, "push");
    const ahead = git(elsewhere, "rev-parse", "HEAD");

    rmSync(worktreeDir, { recursive: true, force: true });
    await apply("sess-2", [
      { op: "reinforce", id: "staging-read-only", sessionId: "sess-2", author: AUTHOR },
    ]);

    expect(git(worktreeDir, "rev-parse", "HEAD~1")).toBe(ahead);
    expect(git(remote, "rev-parse", "--verify", BRANCH)).toBe(git(worktreeDir, "rev-parse", "HEAD"));
    expect(warnings).toEqual([]);
  });

  it("moves an existing worktree onto the branch when the author's slug changes", async () => {
    await apply("sess-1", [{ op: "add", signpost: signpost() }]);

    // branchFor slugs the address's local part, so a new address is a new
    // branch over a worktree still checked out on the old. Committing there
    // put the commit on the old branch and pushed a branch that had nothing.
    const moved = makeCommitPort({
      repoRoot,
      worktreeDir,
      branchPattern: BRANCH_PATTERN,
      author: "greg.rashkevitch@example.com",
      forge,
      warn: (message) => warnings.push(message),
      today: () => TODAY,
    });

    await moved.apply({
      repo: "acme/api",
      repoRoot,
      sessionId: "sess-2",
      operations: [{ op: "add", signpost: signpost({ id: "second", claim: "Second claim" }) }],
    });

    expect(git(worktreeDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      "signposts/greg-rashkevitch",
    );
    expect(git(remote, "rev-parse", "--verify", "signposts/greg-rashkevitch")).toBe(
      git(worktreeDir, "rev-parse", "HEAD"),
    );
    // The first branch keeps its own commit rather than being moved to the tip
    // of the second.
    expect(git(repoRoot, "rev-parse", BRANCH)).not.toBe(git(worktreeDir, "rev-parse", "HEAD"));
    expect(warnings).toEqual([]);
  });

  it("replays an unpushed commit on top of the remote when the branch has diverged", async () => {
    // The dead end this closes: a push fails (offline), so HEAD is ahead; the
    // remote then moves. HEAD stops being an ancestor, so the guarded reset is
    // declined — rightly, it would discard the unpushed commit — and every
    // later run added another commit to a branch whose push was already
    // rejected, for ever.
    //
    // Both sides also rewrite .signposts/index.md, which is what makes the
    // replay conflict: the index is generated from the whole corpus on every
    // commit, so any two commits "change" it.
    await apply("sess-1", [{ op: "add", signpost: signpost() }]);

    const failingPush = path.join(root, "unreachable.git");
    git(repoRoot, "remote", "set-url", "--push", "origin", failingPush);
    await apply("sess-2", [
      { op: "add", signpost: signpost({ id: "mine", claim: "A claim from this machine" }) },
    ]);
    expect(warnings.join("\n")).toContain("could not push");
    const unpushed = git(worktreeDir, "rev-parse", "HEAD");

    // The same developer's other machine commits to the branch and pushes.
    const elsewhere = path.join(root, "elsewhere");
    execFileSync("git", ["clone", "--branch", BRANCH, remote, elsewhere]);
    git(elsewhere, "config", "user.email", "greg@other.example");
    git(elsewhere, "config", "user.name", "Greg Elsewhere");
    git(elsewhere, "config", "commit.gpgsign", "false");
    const theirSignpost = signpost({ id: "theirs", claim: "A claim from the other machine" });
    const theirPath = path.join(elsewhere, SIGNPOSTS_DIRNAME, "environment", "theirs.md");
    writeFileSync(theirPath, serialiseSignpost(theirSignpost), "utf8");
    const indexPath = path.join(elsewhere, SIGNPOSTS_DIRNAME, "index.md");
    writeFileSync(indexPath, `${readFileSync(indexPath, "utf8")}\n| \`theirs\` | theirs | acme/api |\n`, "utf8");
    git(elsewhere, "add", "-A");
    git(elsewhere, "commit", "-m", "from another machine");
    git(elsewhere, "push");
    const theirs = git(elsewhere, "rev-parse", "HEAD");

    // The network comes back.
    git(repoRoot, "remote", "set-url", "--push", "origin", remote);
    warnings = [];
    await apply("sess-3", [
      { op: "add", signpost: signpost({ id: "third", claim: "A third claim" }) },
    ]);

    // The replay landed: their commit is in the history, this machine's
    // unpushed proposal survived it, and the push went through.
    expect(warnings).toEqual([]);
    expect(git(remote, "rev-parse", "--verify", BRANCH)).toBe(git(worktreeDir, "rev-parse", "HEAD"));
    expect(git(worktreeDir, "log", "--pretty=%s")).toContain("from another machine");
    expect(git(worktreeDir, "rev-parse", "HEAD")).not.toBe(unpushed);
    expect(git(worktreeDir, "rev-list", "--count", `${theirs}..HEAD`)).not.toBe("0");

    for (const [category, id] of [
      ["environment", "staging-read-only"],
      ["environment", "mine"],
      ["environment", "theirs"],
      ["environment", "third"],
    ]) {
      expect(existsSync(path.join(worktreeDir, SIGNPOSTS_DIRNAME, category!, `${id!}.md`))).toBe(true);
    }
    // The index was regenerated from the merged corpus, not left with a
    // conflict marker in it.
    const index = readFileSync(path.join(worktreeDir, SIGNPOSTS_DIRNAME, "index.md"), "utf8");
    expect(index).not.toContain("<<<<<<<");
    for (const id of ["staging-read-only", "mine", "theirs", "third"]) {
      expect(index).toContain(id);
    }
  });

  it("writes nothing at all for a session that proposed nothing", async () => {
    await apply("sess-1", []);

    expect(existsSync(worktreeDir)).toBe(false);
    expect(forge.openPrCalls).toEqual([]);
  });
});
