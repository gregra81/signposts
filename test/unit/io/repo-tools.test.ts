// The three read-only tools, against a real filesystem and a real git repo.
//
// The confinement cases come first and are the point: every one of them is a
// path a model could plausibly produce while reasoning about a contradiction,
// and each must be refused *before* anything is read. The test for that is
// not "an error came back" — it is that the file outside the repository,
// which exists and is readable, never appears in the result.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeRepoToolRunner } from "../../../src/io/tools/repo-tools.js";
import { RESOLVE_TOOL_NAMES } from "../../../src/core/graph/resolve-tools.js";
import type { ToolRunner } from "../../../src/core/model/types.js";

const SECRET = "the-secret-outside-the-repo";

let repoRoot: string;
let outside: string;
let run: ToolRunner;

function git(args: string[], cwd = repoRoot): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
}

beforeEach(() => {
  // Real paths, for the reason test/unit/paths/confine.test.ts gives: on
  // macOS $TMPDIR sits under /var -> /private/var.
  repoRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "signposts-tools-")));
  outside = realpathSync(mkdtempSync(path.join(tmpdir(), "signposts-outside-")));
  writeFileSync(path.join(outside, "secret.txt"), SECRET);

  mkdirSync(path.join(repoRoot, "src"));
  writeFileSync(path.join(repoRoot, "src", "config.ts"), "export const STAGING_WRITABLE = false;\n");
  writeFileSync(path.join(repoRoot, "README.md"), "line one\nline two\nline three\nline four\n");

  git(["init", "--quiet", "--initial-branch=main"]);
  git(["add", "."]);
  git(["commit", "--quiet", "--no-gpg-sign", "-m", "Make staging read-only"]);

  run = makeRepoToolRunner(repoRoot);
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("confinement — the boundary is here, not in the prompt", () => {
  it("refuses a read_file path that traverses out of the repository", async () => {
    const result = await run(RESOLVE_TOOL_NAMES.readFile, {
      path: path.join("..", path.basename(outside), "secret.txt"),
    });

    expect(result.isError).toBe(true);
    expect(result.content).not.toContain(SECRET);
  });

  it("refuses an absolute read_file path outside the repository", async () => {
    const result = await run(RESOLVE_TOOL_NAMES.readFile, {
      path: path.join(outside, "secret.txt"),
    });

    expect(result.isError).toBe(true);
    expect(result.content).not.toContain(SECRET);
  });

  it("refuses a symlink inside the repository that resolves outside it", async () => {
    symlinkSync(outside, path.join(repoRoot, "escape"));

    const result = await run(RESOLVE_TOOL_NAMES.readFile, { path: "escape/secret.txt" });

    expect(result.isError).toBe(true);
    expect(result.content).not.toContain(SECRET);
  });

  it("refuses percent-encoded traversal", async () => {
    const result = await run(RESOLVE_TOOL_NAMES.readFile, { path: "%2e%2e/secret.txt" });

    expect(result.isError).toBe(true);
    expect(result.content).not.toContain(SECRET);
  });

  it("refuses a git_log path outside the repository", async () => {
    const result = await run(RESOLVE_TOOL_NAMES.gitLog, { path: outside });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("rejected");
  });

  it("refuses a grep_repo glob that escapes the repository", async () => {
    const result = await run(RESOLVE_TOOL_NAMES.grepRepo, {
      pattern: "secret",
      glob: path.join("..", path.basename(outside), "*"),
    });

    expect(result.isError).toBe(true);
    expect(result.content).not.toContain(SECRET);
  });

  it("still refuses when the repository root itself is reached by a symlink", async () => {
    // A repoRoot the caller reached through a link is fine; a *candidate*
    // that leaves the real root is not. This pins that the containment check
    // runs against the resolved root, so the link does not become a hole.
    const linked = path.join(outside, "link-to-repo");
    symlinkSync(repoRoot, linked);

    const viaLink = makeRepoToolRunner(linked);
    const inside = await viaLink(RESOLVE_TOOL_NAMES.readFile, { path: "README.md" });
    const escaping = await viaLink(RESOLVE_TOOL_NAMES.readFile, { path: "../secret.txt" });

    expect(inside.isError).toBe(false);
    expect(escaping.isError).toBe(true);
    expect(escaping.content).not.toContain(SECRET);
  });
});

describe("arguments that fail their schema", () => {
  it("comes back as a tool error rather than throwing", async () => {
    await expect(run(RESOLVE_TOOL_NAMES.readFile, { path: 42 })).resolves.toMatchObject({
      isError: true,
    });
  });

  it("names the tool that rejected them", async () => {
    const result = await run(RESOLVE_TOOL_NAMES.grepRepo, { glob: "src" });
    expect(result.content).toContain("grep_repo");
  });

  it("reports an unknown tool without throwing", async () => {
    const result = await run("write_file", { path: "README.md" });
    expect(result).toEqual({ content: "unknown tool: write_file", isError: true });
  });
});

describe("read_file", () => {
  it("returns the whole file when no range is given", async () => {
    const result = await run(RESOLVE_TOOL_NAMES.readFile, { path: "src/config.ts" });

    expect(result.isError).toBe(false);
    expect(result.content).toBe("export const STAGING_WRITABLE = false;\n");
  });

  it("returns a 1-based inclusive slice with line numbers", async () => {
    const result = await run(RESOLVE_TOOL_NAMES.readFile, {
      path: "README.md",
      startLine: 2,
      endLine: 3,
    });

    expect(result.content).toBe("2: line two\n3: line three");
  });

  it("clamps an endLine past the end of the file rather than failing", async () => {
    const result = await run(RESOLVE_TOOL_NAMES.readFile, {
      path: "README.md",
      startLine: 3,
      endLine: 999,
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("3: line three");
  });

  it("rejects a range that runs backwards", async () => {
    const result = await run(RESOLVE_TOOL_NAMES.readFile, {
      path: "README.md",
      startLine: 3,
      endLine: 2,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("before startLine");
  });

  it("reports a file that is not there", async () => {
    const result = await run(RESOLVE_TOOL_NAMES.readFile, { path: "src/nope.ts" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("src/nope.ts");
  });

  it("reports a directory as a directory", async () => {
    const result = await run(RESOLVE_TOOL_NAMES.readFile, { path: "src" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("is a directory");
  });

  it("truncates a file too large to hand back whole", async () => {
    writeFileSync(path.join(repoRoot, "big.txt"), "x".repeat(50_000));

    const result = await run(RESOLVE_TOOL_NAMES.readFile, { path: "big.txt" });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("truncated");
    expect(result.content.length).toBeLessThan(50_000);
  });
});

describe("git_log", () => {
  it("returns commits as JSON with hash, author, date and subject", async () => {
    const result = await run(RESOLVE_TOOL_NAMES.gitLog, {});

    expect(result.isError).toBe(false);
    const commits = JSON.parse(result.content) as Array<Record<string, string>>;
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({
      author: "Test",
      subject: "Make staging read-only",
    });
    expect(commits[0]?.hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it("honours a limit", async () => {
    writeFileSync(path.join(repoRoot, "src", "config.ts"), "export const STAGING_WRITABLE = true;\n");
    git(["commit", "--quiet", "--no-gpg-sign", "-a", "-m", "Open staging up again"]);

    const all = await run(RESOLVE_TOOL_NAMES.gitLog, {});
    const one = await run(RESOLVE_TOOL_NAMES.gitLog, { limit: 1 });

    expect(JSON.parse(all.content)).toHaveLength(2);
    expect(JSON.parse(one.content)).toHaveLength(1);
  });

  it("restricts the log to a path inside the repository", async () => {
    writeFileSync(path.join(repoRoot, "unrelated.md"), "no\n");
    git(["add", "unrelated.md"]);
    git(["commit", "--quiet", "--no-gpg-sign", "-m", "Add an unrelated file"]);

    const result = await run(RESOLVE_TOOL_NAMES.gitLog, { path: "src/config.ts" });

    const commits = JSON.parse(result.content) as Array<Record<string, string>>;
    expect(commits.map((commit) => commit.subject)).toEqual(["Make staging read-only"]);
  });

  it("returns an empty list for a path with no history", async () => {
    writeFileSync(path.join(repoRoot, "untracked.md"), "nothing committed\n");

    const result = await run(RESOLVE_TOOL_NAMES.gitLog, { path: "untracked.md" });

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual([]);
  });
});

describe("grep_repo", () => {
  it("returns file, line number and line for each match", async () => {
    const result = await run(RESOLVE_TOOL_NAMES.grepRepo, { pattern: "STAGING_WRITABLE" });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("src/config.ts:1:");
  });

  it("reports no matches as an answer, not as an error", async () => {
    const result = await run(RESOLVE_TOOL_NAMES.grepRepo, { pattern: "nothing-matches-this" });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("no matches");
  });

  it("restricts the search to a glob inside the repository", async () => {
    const everywhere = await run(RESOLVE_TOOL_NAMES.grepRepo, { pattern: "line two" });
    const inSrc = await run(RESOLVE_TOOL_NAMES.grepRepo, { pattern: "line two", glob: "src" });

    expect(everywhere.content).toContain("README.md");
    expect(inSrc.content).toContain("no matches");
  });

  it("hands git's own complaint back, so a bad pattern can be corrected", async () => {
    // A live probe opened with `(?i)(read[-_ ]?only|...)`, which POSIX ERE
    // rejects. The bare exit status said nothing about the regex dialect and
    // cost an iteration of a six-iteration budget.
    const result = await run(RESOLVE_TOOL_NAMES.grepRepo, { pattern: "(?i)staging" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("grep_repo: git grep exited");
    expect(result.content.length).toBeGreaterThan("grep_repo: git grep exited 128".length);
  });

  it("does not run the pattern through a shell", async () => {
    // If this reached a shell, the `;` would end the grep and `touch` would
    // run. The array form of spawnSync is what stops it.
    const marker = path.join(repoRoot, "pwned.txt");
    const result = await run(RESOLVE_TOOL_NAMES.grepRepo, {
      pattern: `x"; touch ${marker}; echo "`,
    });

    expect(result.isError).toBe(false);
    expect(() => realpathSync(marker)).toThrow();
  });
});
