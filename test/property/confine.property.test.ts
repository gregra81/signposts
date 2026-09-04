// Tier 2 property test for confine() (12-wire-contracts.md, tools phase, P8).

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { confine } from "../../src/core/paths/confine.js";
import { nodePathFacts } from "../../src/io/paths/node-path-facts.js";

describe("confine property tests", () => {
  let repoRoot: string;

  beforeEach(() => {
    // Real path: on macOS $TMPDIR sits under a symlink (/var ->
    // /private/var), and confine() returns realpath-resolved output.
    repoRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "signposts-confine-prop-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("P8: for any candidatePath, result is either ok:false or ok:true with a path inside repoRoot", () => {
    fc.assert(
      fc.property(fc.string(), (candidatePath) => {
        const result = confine(repoRoot, candidatePath, nodePathFacts);

        if (result.ok) {
          const rel = path.relative(repoRoot, result.path);
          expect(path.isAbsolute(result.path)).toBe(true);
          expect(rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))).toBe(
            true,
          );
        } else {
          expect(typeof result.reason).toBe("string");
        }
      }),
    );
  });
});
