// Confines untrusted, model-supplied candidate paths to repoRoot
// (12-wire-contracts.md, tools phase). Every escape route — textual `..`
// traversal, absolute paths outside repoRoot, symlinks that resolve
// outside repoRoot, percent-encoded traversal — is rejected. Never
// throws: any failure comes back as `{ ok: false, reason }`.

import path from "node:path";

export type ConfineResult = { ok: true; path: string } | { ok: false; reason: string };

/**
 * The three filesystem questions confinement has to ask, as a port.
 *
 * Symlink resolution cannot be done from a string: `a/b/c` is only outside
 * repoRoot if something on disk says so. So this module needs a real
 * filesystem — but it does not need `node:fs`, and taking these three as an
 * argument is what keeps the walk-up, the hop counting and every containment
 * decision in core, where they are mutation-graded, rather than in io, where
 * they are not.
 *
 * src/io/paths/node-path-facts.ts is the implementation over `node:fs`.
 */
export interface PathFacts {
  /**
   * `lstat`, or `undefined` when nothing exists at `p`. Every other failure
   * throws — a path running through a file, a symlink loop, a permission
   * error — so it surfaces as a `confine failed` reason rather than being
   * mistaken for a path that has simply not been created yet.
   */
  lstat(p: string): { isSymbolicLink: boolean } | undefined;
  /** The literal target of a symlink, absolute or relative as stored. */
  readlink(p: string): string;
  /** The canonical path, with every symlink resolved. */
  realpath(p: string): string;
}

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

/** Linux's MAXSYMLINKS, the point at which `realpath` gives up with ELOOP. */
const MAX_SYMLINK_HOPS = 40;

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
 *
 * Termination: the two walk-up recursions shorten the path by one segment
 * each time and stop at the filesystem root, which exists. Following a
 * symlink target has no such bound — `a -> b -> a` would recurse until the
 * stack ran out — so `hops` caps it the way MAXSYMLINKS caps
 * `realpath`, and a cycle comes back as a `confine failed` reason.
 */
function realpathOrWalkUp(facts: PathFacts, p: string, hops = 0): string {
  const stat = facts.lstat(p);

  if (stat === undefined) {
    return path.join(realpathOrWalkUp(facts, path.dirname(p), hops), path.basename(p));
  }

  if (stat.isSymbolicLink) {
    if (hops >= MAX_SYMLINK_HOPS) {
      throw new Error(`too many symbolic links: ${p}`);
    }
    const parentReal = realpathOrWalkUp(facts, path.dirname(p), hops);
    const target = facts.readlink(p);
    const resolvedTarget = path.isAbsolute(target) ? target : path.resolve(parentReal, target);
    return realpathOrWalkUp(facts, resolvedTarget, hops + 1);
  }

  return facts.realpath(p);
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
export function confine(
  repoRoot: string,
  candidatePath: string,
  facts: PathFacts,
): ConfineResult {
  try {
    if (candidatePath.trim() === "") {
      return { ok: false, reason: "candidatePath is empty" };
    }

    if (hasDangerousPercentEscape(candidatePath)) {
      return { ok: false, reason: `percent-encoded separator/dot rejected: ${candidatePath}` };
    }

    const repoRootReal = realpathOrWalkUp(facts, path.resolve(repoRoot));

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

    const real = realpathOrWalkUp(facts, lexical);

    if (!isInside(repoRootReal, real)) {
      return { ok: false, reason: `resolved path escapes repoRoot: ${candidatePath}` };
    }

    return { ok: true, path: real };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `confine failed: ${message}` };
  }
}
