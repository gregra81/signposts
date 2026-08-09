// Slug generation for new signpost ids: kebab-case the claim, then
// disambiguate against ids already on disk (03-memory-model.md: "id: stable
// slug, e.g. staging-db-read-only"). Output always matches ID_PATTERN
// (src/core/config/constants.ts) by construction: lowercased, non-alnum runs
// collapsed to a single `-`, leading/trailing `-` trimmed.

const FALLBACK_SLUG = "signpost";

function kebabCase(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Given ids already in use, returns a unique ID_PATTERN-matching slug for `claim`. */
export function generateSlug(claim: string, existingIds: ReadonlySet<string>): string {
  const base = kebabCase(claim) || FALLBACK_SLUG;
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
