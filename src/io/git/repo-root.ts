// The top of the working tree, from anywhere inside it.
//
// `buildProductionApp` took repoRoot from `process.cwd()` and never looked for
// a git root, so `signpost sessions` typed in `<repo>/lib` encoded that path,
// looked for a transcript directory that has never existed, and printed
// `{ "sessions": [] }` at exit 0 — indistinguishable from a repo with no idle
// sessions (18-end-to-end-gaps.md, item 8). It also split the state directory
// quietly, since every state path is keyed on `sha256(repoRoot)`, so the
// database, the checkpoints and the lock all moved with the shell.
//
// src/core/transcript/project-dir.ts carries a long comment about this exact
// failure reached through the path *encoding*, and closes it there. This is
// the same hole through the path itself.
//
// **Walking for `.git` rather than shelling out to `git rev-parse`.** It is
// the composition root, so it runs before every command including `doctor`,
// and a subprocess per invocation for a fact three `stat` calls answer is a
// cost the hook's budget would notice. `.git` is matched as either a
// directory or a file: a linked worktree — which is how `commit` writes
// (src/io/git/worktree.ts) — has a `.git` file pointing at the real one, and
// its top is still the top of a working tree.

import { existsSync } from "node:fs";
import path from "node:path";

/**
 * The nearest ancestor of `from` (inclusive) holding a `.git`, or `null` when
 * there is none.
 *
 * Null rather than a throw: `doctor` has to run outside a repository, and the
 * commands that cannot are already the ones that fail on a missing `origin`
 * with a message that says so (src/io/open-run.ts).
 */
export function findRepoRoot(from: string): string | null {
  let current = path.resolve(from);

  for (;;) {
    if (existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}
