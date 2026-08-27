// Confines untrusted, model-supplied candidate paths to repoRoot
// (12-wire-contracts.md, tools phase). Every escape route — textual `..`
// traversal, absolute paths outside repoRoot, symlinks that resolve
// outside repoRoot, percent-encoded traversal — is rejected. Never
// throws: any failure comes back as `{ ok: false, reason }`.

import fs from "node:fs";
import path from "node:path";

export type ConfineResult = { ok: true; path: string } | { ok: false; reason: string };

/**
 * `path.relative`-based containment check — a segment-boundary check,
 * not a string prefix check, so `/repo-evil` is correctly rejected
 * against parent `/repo` (a naive `startsWith("/repo")` would accept it).
 * An empty `rel` means the two paths are the same, which counts as inside.
 */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * `fs.lstatSync`, with "doesn't exist" reported as `undefined` instead of
 * a throw. Every other error (ENOTDIR on a path that runs through a file,
 * ELOOP, EACCES, an invalid argument) still throws, so it surfaces as a
 * `confine failed` reason rather than being mistaken for a path that has
 * simply not been created yet.
 */
function lstatOrUndefined(p: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * Resolves symlinks via the real fs. When `p` doesn't exist yet, walks up
 * to the longest existing ancestor, resolves that ancestor for real, and
 * rejoins the non-existent tail — so a not-yet-created file still gets its
 * existing symlinked parent directories resolved, while a missing leaf
 * doesn't make realpath throw. The walk terminates because the filesystem
 * root always exists.
 *
 * A symlink is resolved through `readlink` rather than `realpath` so a
 * *dangling* link (its target doesn't exist) is not mistaken for a path
 * that doesn't exist: writing through such a link lands wherever the link
 * points, so the target's own resolution and containment is what matters,
 * not `p`'s.
 */
function realpathOrWalkUp(p: string): string {
  const stat = lstatOrUndefined(p);

  if (stat === undefined) {
    return path.join(realpathOrWalkUp(path.dirname(p)), path.basename(p));
  }

  if (stat.isSymbolicLink()) {
    const parentReal = realpathOrWalkUp(path.dirname(p));
    const target = fs.readlinkSync(p);
    const resolvedTarget = path.isAbsolute(target) ? target : path.resolve(parentReal, target);
    return realpathOrWalkUp(resolvedTarget);
  }

  return fs.realpathSync(p);
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
