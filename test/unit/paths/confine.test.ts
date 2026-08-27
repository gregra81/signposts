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
    // The link points *sideways* to a sibling, not back at its own parent, so
    // repoRoot's real path lands outside the tree its lexical path names. That
    // is what makes confine's lexical-root fallback observable: a link to its
    // own parent leaves the real root an ancestor of the lexical one, and both
    // containment checks agree. On macOS a self-link happens to diverge anyway
    // ($TMPDIR sits under /var -> /private/var), but on Linux /tmp is real and
    // the fallback would go untested.
    const base = realpathSync(mkdtempSync(path.join(tmpdir(), "signposts-confine-linked-")));
    const realRoot = path.join(base, "real-root");
    mkdirSync(realRoot);
    const linkedRoot = path.join(base, "link-to-root");
    symlinkSync(realRoot, linkedRoot);

    const fileResult = confine(linkedRoot, path.join(linkedRoot, "ok.txt"));
    expect(fileResult).toEqual({ ok: true, path: path.join(realRoot, "ok.txt") });

    const rootResult = confine(linkedRoot, linkedRoot);
    expect(rootResult).toEqual({ ok: true, path: realRoot });

    rmSync(base, { recursive: true, force: true });
  });

  it("rejects repoRoot's own parent directory", () => {
    const parent = path.dirname(repoRoot);

    const result = confine(repoRoot, parent);

    expect(result).toEqual({ ok: false, reason: `path escapes repoRoot: ${parent}` });
  });

  it("rejects a lexically escaping path even when it symlinks back inside repoRoot", () => {
    const sibling = mkdtempSync(path.join(tmpdir(), "signposts-confine-sibling-"));
    symlinkSync(repoRoot, path.join(sibling, "back"));
    const candidate = `../${path.basename(sibling)}/back/file.txt`;

    const result = confine(repoRoot, candidate);

    expect(result).toEqual({ ok: false, reason: `path escapes repoRoot: ${candidate}` });
    rmSync(sibling, { recursive: true, force: true });
  });

  it("reports a resolved-symlink escape distinctly from a lexical one", () => {
    const outside = mkdtempSync(path.join(tmpdir(), "signposts-confine-outside-"));
    symlinkSync(outside, path.join(repoRoot, "escape-link"));

    const result = confine(repoRoot, "escape-link/secret.txt");

    expect(result).toEqual({
      ok: false,
      reason: "resolved path escapes repoRoot: escape-link/secret.txt",
    });
    rmSync(outside, { recursive: true, force: true });
  });

  it("rejects a candidate routed through a regular file (ENOTDIR), rather than treating it as not-yet-created", () => {
    writeFileSync(path.join(repoRoot, "file.txt"), "hi");

    const result = confine(repoRoot, "file.txt/child.txt");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^confine failed: /);
  });

  it("rejects a single percent-encoded dot, even naming a file that really exists", () => {
    writeFileSync(path.join(repoRoot, "%2e"), "literally named %2e");

    const result = confine(repoRoot, "%2e");

    expect(result).toEqual({
      ok: false,
      reason: "percent-encoded separator/dot rejected: %2e",
    });
  });

  it("decodes a percent escape that is not a dot or separator", () => {
    const result = confine(repoRoot, "%41.txt");

    expect(result).toEqual({ ok: true, path: path.join(repoRoot, "A.txt") });
  });

  it("names the empty candidatePath in the reason", () => {
    expect(confine(repoRoot, "  ")).toEqual({ ok: false, reason: "candidatePath is empty" });
  });

  it("reports the underlying failure when the fs call throws", () => {
    const result = confine(repoRoot, "\0bad");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^confine failed: /);
  });
  it("rejects a symlink cycle instead of recursing until the stack runs out", () => {
    symlinkSync(path.join(repoRoot, "b"), path.join(repoRoot, "a"));
    symlinkSync(path.join(repoRoot, "a"), path.join(repoRoot, "b"));

    const result = confine(repoRoot, "a");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^confine failed: too many symbolic links: /);
  });

  it("rejects a symlink pointing at itself", () => {
    symlinkSync(path.join(repoRoot, "self"), path.join(repoRoot, "self"));

    const result = confine(repoRoot, "self");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^confine failed: too many symbolic links: /);
  });

  // The hop limit is Linux's MAXSYMLINKS (40). A chain right at the
  // limit must still resolve, or the bound that stops a cycle would also
  // reject legitimately deep symlink chains.
  const chainOf = (repoRoot: string, links: number): string => {
    writeFileSync(path.join(repoRoot, "chain-target.txt"), "end of the chain");
    let previous = "chain-target.txt";
    for (let i = links - 1; i >= 0; i -= 1) {
      symlinkSync(path.join(repoRoot, previous), path.join(repoRoot, `link-${i}`));
      previous = `link-${i}`;
    }
    return previous;
  };

  it("resolves a symlink chain exactly at the hop limit", () => {
    const head = chainOf(repoRoot, 40);

    const result = confine(repoRoot, head);

    expect(result).toEqual({ ok: true, path: path.join(repoRoot, "chain-target.txt") });
  });

  it("rejects a symlink chain one hop past the limit", () => {
    const head = chainOf(repoRoot, 41);

    const result = confine(repoRoot, head);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^confine failed: too many symbolic links: /);
  });
});
