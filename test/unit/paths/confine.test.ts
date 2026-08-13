import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { confine } from "../../../src/core/paths/confine.js";

describe("confine", () => {
  let repoRoot: string;

  beforeEach(() => {
    // Real path, not the raw mkdtemp result: on macOS $TMPDIR sits under a
    // symlink (/var -> /private/var), so confine's realpath resolution
    // would otherwise return a path that differs from a raw-repoRoot join.
    repoRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "signposts-confine-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("rejects .. traversal that escapes repoRoot", () => {
    const result = confine(repoRoot, "../../etc/passwd");
    expect(result.ok).toBe(false);
  });

  it("rejects .. traversal buried mid-path (a/../../b)", () => {
    const result = confine(repoRoot, "a/../../b");
    expect(result.ok).toBe(false);
  });

  it("rejects a symlink that resolves outside repoRoot", () => {
    const outside = mkdtempSync(path.join(tmpdir(), "signposts-confine-outside-"));
    writeFileSync(path.join(outside, "secret.txt"), "top secret");
    symlinkSync(outside, path.join(repoRoot, "escape-link"));

    const result = confine(repoRoot, "escape-link/secret.txt");

    expect(result.ok).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  it("rejects a dangling symlink whose target is outside repoRoot", () => {
    const outsideTarget = path.join(mkdtempSync(path.join(tmpdir(), "signposts-confine-outside-")), "not-yet.txt");
    symlinkSync(outsideTarget, path.join(repoRoot, "dangling"));

    const result = confine(repoRoot, "dangling");

    expect(result.ok).toBe(false);
  });

  it("accepts a dangling symlink whose target is inside repoRoot", () => {
    const insideTarget = path.join(repoRoot, "not-yet.txt");
    symlinkSync(insideTarget, path.join(repoRoot, "dangling-inside"));

    const result = confine(repoRoot, "dangling-inside");

    expect(result).toEqual({ ok: true, path: insideTarget });
  });

  it("rejects an absolute path outside repoRoot", () => {
    const result = confine(repoRoot, "/etc/passwd");
    expect(result.ok).toBe(false);
  });

  it("accepts an absolute path that resolves inside repoRoot", () => {
    const target = path.join(repoRoot, "file.txt");
    writeFileSync(target, "hi");

    const result = confine(repoRoot, target);

    expect(result).toEqual({ ok: true, path: target });
  });

  it("rejects percent-encoded traversal (%2e%2e)", () => {
    const result = confine(repoRoot, "%2e%2e/%2e%2e/etc/passwd");
    expect(result.ok).toBe(false);
  });

  it("rejects a sibling directory that shares repoRoot as a string prefix", () => {
    const sibling = `${repoRoot}-evil`;
    mkdirSync(sibling, { recursive: true });

    const result = confine(repoRoot, sibling);

    expect(result.ok).toBe(false);
    rmSync(sibling, { recursive: true, force: true });
  });

  it("accepts a file that merely looks like traversal (named '..foo')", () => {
    const target = path.join(repoRoot, "..foo");
    writeFileSync(target, "not a traversal");

    const result = confine(repoRoot, "..foo");

    expect(result).toEqual({ ok: true, path: target });
  });

  it("accepts a not-yet-existing file resolved lexically inside repoRoot", () => {
    const result = confine(repoRoot, "new-file.txt");
    expect(result).toEqual({ ok: true, path: path.join(repoRoot, "new-file.txt") });
  });

  it("rejects an empty candidatePath", () => {
    expect(confine(repoRoot, "").ok).toBe(false);
    expect(confine(repoRoot, "   ").ok).toBe(false);
  });

  it("never throws", () => {
    expect(() => confine(repoRoot, "\0bad")).not.toThrow();
  });

  it("accepts an absolute path inside repoRoot when repoRoot itself is a non-canonical symlink hop", () => {
    const realTmp = mkdtempSync(path.join(tmpdir(), "signposts-confine-linked-"));
    const linkedRoot = path.join(realTmp, "link-to-self");
    symlinkSync(realTmp, linkedRoot);

    const fileResult = confine(linkedRoot, path.join(linkedRoot, "ok.txt"));
    expect(fileResult.ok).toBe(true);

    const rootResult = confine(linkedRoot, linkedRoot);
    expect(rootResult.ok).toBe(true);

    rmSync(realTmp, { recursive: true, force: true });
  });
});
