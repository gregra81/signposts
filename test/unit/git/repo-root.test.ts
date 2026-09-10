// 18-end-to-end-gaps.md item 8: `buildProductionApp` took repoRoot from
// `process.cwd()`, so `signpost sessions` from `<repo>/lib` looked for a
// transcript directory that has never existed and printed `{"sessions": []}`
// at exit 0 — the same output as a repo with nothing to do. It also keyed the
// state directory on that path, so the database moved with the shell.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findRepoRoot } from "../../../src/io/git/repo-root.js";

describe("findRepoRoot", () => {
  let root: string;

  beforeEach(() => {
    // realpath: macOS hands back /var, which is a symlink to /private/var.
    root = mkdtempSync(path.join(tmpdir(), "signposts-root-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("finds the root from a subdirectory several levels down", () => {
    const repo = path.join(root, "repo");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    const deep = path.join(repo, "packages", "web", "src");
    mkdirSync(deep, { recursive: true });

    expect(findRepoRoot(deep)).toBe(repo);
  });

  it("finds the root when standing on it", () => {
    const repo = path.join(root, "repo");
    mkdirSync(path.join(repo, ".git"), { recursive: true });

    expect(findRepoRoot(repo)).toBe(repo);
  });

  // A linked worktree — which is how `commit` writes (src/io/git/worktree.ts) —
  // has a `.git` file rather than a directory, and its top is still a top.
  it("accepts a .git that is a file, as a linked worktree has", () => {
    const worktree = path.join(root, "worktree");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(path.join(worktree, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n", "utf8");

    expect(findRepoRoot(path.join(worktree))).toBe(worktree);
  });

  it("answers null outside a repository rather than climbing to /", () => {
    const orphan = path.join(root, "not-a-repo");
    mkdirSync(orphan, { recursive: true });

    // The temp root itself is not in a repo, so nothing above it is either.
    expect(findRepoRoot(orphan)).toBe(null);
  });
});
