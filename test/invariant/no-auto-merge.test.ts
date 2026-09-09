// "Never auto-merge. Not configurable." (06-review-and-pr.md). The moment
// signposts merges its own pull requests it is an unreviewed automatic memory
// tool, which is the thing it exists not to be.
//
// Omission is not enforcement. Nothing in the Forge port merges today, and
// nothing in review catches the line that adds it: `gh pr merge --auto` is
// four tokens inside a function that already spawns `gh`, and the test suite
// that mocks the forge would stay green. So this reads the implementations
// that can actually reach a forge or a git remote and fails on any
// merge-capable call in them.
//
// A grep, deliberately — it is the only check that survives the call being
// made a way nobody predicted (a REST endpoint, a GraphQL mutation, a `gh`
// alias). Its limit is the mirror image: an argument list assembled at
// runtime hides the word. The interface check below covers the shape a
// deliberate addition would take; the grep covers the accidental one.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Forge } from "../../src/io/forge/forge.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IO_ROOT = path.join(HERE, "..", "..", "src", "io");

/**
 * `merge`, in any casing, in anything that is not `merge-base` — which is
 * `git merge-base --is-ancestor`, a read-only question src/io/git/worktree.ts
 * asks to decide whether it may fast-forward.
 *
 * Broad on purpose. It catches `["pr", "merge"]`, `--auto`'s command,
 * `mergePullRequest`, `enablePullRequestAutoMerge` and the REST
 * `/pulls/{n}/merge`, without needing to know which of them a future author
 * would reach for.
 */
const MERGE_CALL = /merge(?!-base)/i;

/** What a Forge is allowed to do. A merge is not on it, and neither is anything unlisted. */
const ALLOWED_FORGE_METHODS = ["branchesUnder", "openPr", "readPrBody", "updatePr", "setLabels"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : entry.name.endsWith(".ts") ? [full] : [];
  });
}

/**
 * Comments are stripped before the grep, because they are where the rule is
 * explained: half the files below say "never merges" in prose, and a grep that
 * counted those would either fail from the start or have to be narrowed until
 * it stopped catching anything.
 *
 * Written as a scanner rather than a regex over the whole file: a `//` inside
 * a string literal is not a comment, and a regex cannot tell the difference.
 */
function stripComments(source: string): string {
  let out = "";
  let index = 0;

  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];

    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      out += char;
      index += 1;
      while (index < source.length && source[index] !== char) {
        // A backslash consumes what follows it, so an escaped quote does not
        // end the literal and leave the rest of the file read as a string.
        if (source[index] === "\\") {
          out += source[index]! + (source[index + 1] ?? "");
          index += 2;
          continue;
        }
        out += source[index];
        index += 1;
      }
      out += source[index] ?? "";
      index += 1;
      continue;
    }

    out += char;
    index += 1;
  }

  return out;
}

/**
 * Every module under src/io/ that can reach a forge or a git remote — which
 * is every module that spawns a subprocess or opens a network connection.
 *
 * Derived rather than listed, so a new file that shells out is covered the
 * day it is written. Test doubles fall out of it on their own: FakeForge has
 * a `merge()` that ends a review cycle, and it is a fact recorded in a Map,
 * not a call to anything.
 */
function reachesTheOutsideWorld(source: string): boolean {
  return /node:child_process|\bfetch\s*\(/.test(source);
}

describe("no path can merge a pull request", () => {
  const candidates = sourceFiles(IO_ROOT).map((file) => ({
    file: path.relative(path.join(HERE, "..", ".."), file),
    code: stripComments(readFileSync(file, "utf8")),
  }));
  const reaching = candidates.filter((candidate) => reachesTheOutsideWorld(candidate.code));

  it("has modules that reach a forge or a remote, so the grep below is looking at something", () => {
    expect(reaching.map((candidate) => candidate.file)).toContain("src/io/forge/gh-forge.ts");
  });

  it.each(reaching)("$file contains no merge-capable call", ({ code }) => {
    const offending = code
      .split("\n")
      .map((line, number) => ({ line: line.trim(), number: number + 1 }))
      .filter((entry) => MERGE_CALL.test(entry.line));

    expect(offending).toEqual([]);
  });

  it("catches the call it is meant to catch", () => {
    // The rule proving itself: the line someone would actually add.
    expect(MERGE_CALL.test(`gh(cwd, ["pr", "merge", "--auto", "--squash"])`)).toBe(true);
    expect(MERGE_CALL.test(`fetch(\`/repos/\${repo}/pulls/\${n}/merge\`, { method: "PUT" })`)).toBe(true);
    expect(MERGE_CALL.test(`gh(cwd, ["api", "graphql", "-f", "query=enablePullRequestAutoMerge"])`)).toBe(true);
    // And leaves the read-only question worktree.ts asks alone.
    expect(MERGE_CALL.test(`git(worktreeDir, ["merge-base", "--is-ancestor", "HEAD", remoteRef])`)).toBe(false);
  });

  it("offers no merge on the Forge port itself", () => {
    // The interface is the other way in: a merge added as a port method is a
    // deliberate act, and this fails it at the type level as well as by name.
    const forge: Record<keyof Forge, true> = {
      branchesUnder: true,
      openPr: true,
      readPrBody: true,
      updatePr: true,
      setLabels: true,
    };

    expect(Object.keys(forge).sort()).toEqual([...ALLOWED_FORGE_METHODS].sort());
  });
});
