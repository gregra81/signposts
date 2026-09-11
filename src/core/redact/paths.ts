// A file path as it should reach a prompt: relative to the repository it is
// in, or gone.
//
// 02-ingestion.md is right that `filesTouched` has to be redacted, because an
// absolute path carries a home directory name and a home directory name is
// usually a person. It is a pattern job everywhere else in this directory, and
// this is the one place it is not: a path is structured, we know where the
// repo root is, and the structure answers the question the patterns can only
// guess at.
//
// The guess was expensive. `redactHighEntropy` matched
// `[A-Za-z0-9+/]{32,}`, and `/` in that class means any run of thirty-two path
// characters uninterrupted by a dot, dash or underscore is a "secret"
// (18-end-to-end-gaps.md, item 4):
//
//   src/main/java/com/acme/payments/gateway/RetryPolicy.java
//     -> [REDACTED:high-entropy].java
//
// Deep paths are false positives and the filename goes with them. Paths are
// what `scope.paths` is built from, what `pathOverlapBoost` scores, and what
// the CLAUDE.md pointer means by "any signpost whose scope matches the files
// you're changing" — so that is quality lost on every extraction, silently.
// `/` is out of the class now, and this is what covers the home directory
// instead.
//
// PURE: `path.posix`/`path.win32` only, no `fs`, no cwd.

import path from "node:path";

/**
 * `repoRoot`-relative when the path is inside the repo; unchanged otherwise.
 *
 * This function has one job, which is the repo's own paths — the ones
 * `scope.paths` and `pathOverlapBoost` are built from, and the ones a home
 * directory prefix was making unusable.
 *
 * **A path above the root still leaves the machine whole, and that is a known
 * limit rather than a thing this closes.** It goes through the redactor chain
 * like any other text, but the chain matches secrets and email addresses, and
 * a bare username is neither: measured, `/Users/dana/other-repo/src/config.ts`
 * comes back unchanged. Not a regression — the entropy pattern never matched
 * it either, since `Users/dana/other` is sixteen characters — but 02-ingestion.md
 * wants no absolute path leaving at all, and closing that means one rule for
 * the whole field (a placeholder plus the basename, or the home prefix passed
 * in the way repoRoot is). 18-end-to-end-gaps.md item 4 asked only for the
 * repo-relative half.
 */
export function repoRelativePath(filePath: string, repoRoot: string): string {
  if (!path.isAbsolute(filePath)) {
    return filePath;
  }

  const relative = path.relative(repoRoot, filePath);
  // `path.relative` answers with a `..` prefix for anything above the root,
  // and with an absolute path when the two are on different Windows volumes.
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return filePath;
  }
  return relative;
}
