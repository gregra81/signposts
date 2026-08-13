// Confines untrusted, model-supplied candidate paths to repoRoot
// (12-wire-contracts.md, tools phase). Every escape route — textual `..`
// traversal, absolute paths outside repoRoot, symlinks that resolve
// outside repoRoot, percent-encoded traversal — is rejected. Never
// throws: any failure comes back as `{ ok: false, reason }`.

import fs from "node:fs";
import path from "node:path";

export type ConfineResult = { ok: true; path: string } | { ok: false; reason: string };

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/**
 * `path.relative`-based containment check — a segment-boundary check,
 * not a string prefix check, so `/repo-evil` is correctly rejected
 * against parent `/repo` (a naive `startsWith("/repo")` would accept it).
 */
function isInside(parent: string, child: string): boolean {
  if (child === parent) return true;
  const rel = path.relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * Resolves symlinks via the real fs. When `p` (or some suffix of it)
 * doesn't exist yet, walks up to the longest existing ancestor, resolves
 * that ancestor for real, and rejoins the non-existent tail — so a
 * not-yet-created file still gets its existing symlinked parent
 * directories resolved, while a missing leaf doesn't make realpath throw.
 *
 * `fs.realpathSync` also throws ENOENT when `p` itself exists but is a
 * *dangling* symlink (its target doesn't exist) — that case must not be
 * treated as "doesn't exist yet" and rejoined as a literal path segment,
 * or the dangling link's in-root path would be returned as confined even
 * though writing through it lands wherever the link points. So on ENOENT,
 * lstat `p` first: if it's a symlink, resolve its target (against the
 * already-resolved parent, for relative targets) and recurse on that —
 * the target's own resolution/containment is what matters, not `p`'s.
 */
function realpathOrWalkUp(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch (err) {
    if (!isNodeError(err) || err.code !== "ENOENT") throw err;
  }

  try {
    const stat = fs.lstatSync(p);
    if (stat.isSymbolicLink()) {
      const parentReal = realpathOrWalkUp(path.dirname(p));
      const target = fs.readlinkSync(p);
      const resolvedTarget = path.isAbsolute(target) ? target : path.resolve(parentReal, target);
      return realpathOrWalkUp(resolvedTarget);
    }
  } catch (err) {
    if (!isNodeError(err) || err.code !== "ENOENT") throw err;
  }

  const parent = path.dirname(p);
  if (parent === p) return p;
  return path.join(realpathOrWalkUp(parent), path.basename(p));
}

/**
 * `%XX` escapes that decode to `.` or a path separator are rejected
 * outright rather than decoded-and-resolved: decoding them and then
 * confining the result can silently return a *different* path than the
 * one the candidate's literal characters name on disk (e.g. a real file
 * named `%2e%2e` decodes to `..` and would resolve to repoRoot itself,
 * not to that file).
 */
const DANGEROUS_DECODED_CHARS = new Set([".", "/", "\\"]);

function hasDangerousPercentEscape(candidatePath: string): boolean {
  const re = /%([0-9a-fA-F]{2})/g;
  for (const match of candidatePath.matchAll(re)) {
    const hex = match[1];
    if (hex === undefined) continue;
    const ch = String.fromCharCode(parseInt(hex, 16));
    if (DANGEROUS_DECODED_CHARS.has(ch)) return true;
  }
  return false;
}

/**
 * `confine(repoRoot, candidatePath)` returns the absolute, canonical,
 * repoRoot-confined path, or a reason it can't be confined. Percent-encoded
 * segments (e.g. `%2e%2e`) that would decode to a dot or path separator are
 * rejected outright (see `hasDangerousPercentEscape`); other percent
 * escapes are decoded before the containment check, so encoded traversal
 * is caught the same way literal traversal is. Malformed percent-encoding
 * is treated as a literal string.
 */
export function confine(repoRoot: string, candidatePath: string): ConfineResult {
  try {
    if (candidatePath.trim() === "") {
      return { ok: false, reason: "candidatePath is empty" };
    }

    if (hasDangerousPercentEscape(candidatePath)) {
      return { ok: false, reason: `percent-encoded separator/dot rejected: ${candidatePath}` };
    }

    const repoRootReal = realpathOrWalkUp(path.resolve(repoRoot));

    let decoded: string;
    try {
      decoded = decodeURIComponent(candidatePath);
    } catch {
      decoded = candidatePath;
    }

    const lexical = path.isAbsolute(decoded)
      ? path.normalize(decoded)
      : path.resolve(repoRootReal, decoded);

    const repoRootLexical = path.resolve(repoRoot);

    if (!isInside(repoRootReal, lexical) && !isInside(repoRootLexical, lexical)) {
      return { ok: false, reason: `path escapes repoRoot: ${candidatePath}` };
    }

    const real = realpathOrWalkUp(lexical);

    if (!isInside(repoRootReal, real)) {
      return { ok: false, reason: `resolved path escapes repoRoot: ${candidatePath}` };
    }

    return { ok: true, path: real };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `confine failed: ${message}` };
  }
}
