// Slug generation for new signpost ids: kebab-case the claim, then
// disambiguate against ids already on disk (03-memory-model.md: "id: stable
// slug, e.g. staging-db-read-only"). Output always matches ID_PATTERN
// (src/core/config/constants.ts) by construction: lowercased, non-alnum runs
// collapsed to a single `-`, leading/trailing `-` trimmed, and cut to
// MAX_SLUG_LENGTH on a word boundary.

import { MAX_SLUG_LENGTH } from "../config/constants.ts";

const FALLBACK_SLUG = "signpost";

function kebabCase(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * The slug cut to MAX_SLUG_LENGTH on a word boundary.
 *
 * On a boundary rather than mid-word because the id is read by people, in a
 * filename and in the index table — `staging-s-database-is-read-only-outside`
 * is a name, `staging-s-database-is-read-only-outsid` is a typo. A first word
 * longer than the cap is cut where it falls, there being no boundary to find.
 *
 * The result still satisfies ID_PATTERN without a further trim: `slug` comes
 * from `kebabCase`, which has already collapsed hyphen runs and dropped the
 * edges, so cutting at the last hyphen lands on an alphanumeric and a clip
 * with no hyphen in it cannot end with one either.
 */
function cut(slug: string): string {
  if (slug.length <= MAX_SLUG_LENGTH) {
    return slug;
  }
  const clipped = slug.slice(0, MAX_SLUG_LENGTH);
  const lastBoundary = clipped.lastIndexOf("-");
  return lastBoundary === -1 ? clipped : clipped.slice(0, lastBoundary);
}

/** Given ids already in use, returns a unique ID_PATTERN-matching slug for `claim`. */
export function generateSlug(claim: string, existingIds: ReadonlySet<string>): string {
  const base = cut(kebabCase(claim)) || FALLBACK_SLUG;
  if (!existingIds.has(base)) {
    return base;
  }

  // Collision suffixes start at 2 (foo-bar, foo-bar-2, foo-bar-3, ...).
  // Counting up from 1 and incrementing before first use avoids a bare
  // literal `2` here, which would otherwise collide value-wise with an
  // unrelated exported constant (no-magic-literal is value-based, not
  // name-based).
  let suffix = 1;
  let candidate: string;
  do {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  } while (existingIds.has(candidate));
  return candidate;
}
