// The branch a developer's proposals land on: `signposts/<author-slug>`,
// derived from `git config user.email` (06-review-and-pr.md, "PR mechanics").
//
// Per developer, not per repo, and long-lived. Every teammate runs their own
// worker on their own machine, concurrently and unaware of each other; one
// shared branch turns that into push races and into reviewing proposals from
// sessions you were never present for.
//
// Pure: an email and the configured pattern in, a branch name out. Reading
// the email is git's business (src/io/git/).

const AUTHOR_SLUG_PLACEHOLDER = "{author_slug}";

/** Anything outside the slug alphabet, collapsed to one separator. */
const NON_SLUG = /[^a-z0-9]+/g;

/**
 * The local part of the email, lowercased and reduced to `a-z0-9-`.
 *
 * Leading and trailing separators are dropped, which also absorbs surrounding
 * whitespace: it becomes a dash on the way through and is stripped here.
 *
 * The local part rather than the whole address, because the branch is read by
 * people: `signposts/greg` says whose proposals these are, where
 * `signposts/greg-example-com` says it twice and reads like a typo. Two
 * developers with the same local part on different domains collide, and that
 * is survivable — they are on different machines with different clones, and
 * the branch is only ever pushed to a remote they both read.
 */
export function authorSlug(email: string): string {
  // `split` always yields at least one element, so the local part is the
  // whole string for an address with no `@` — a bare git author name.
  const localPart = email.toLowerCase().split("@")[0]!;
  // NON_SLUG has already collapsed any run to a single dash, so at most one
  // can be leading and one trailing.
  const slug = localPart.replace(NON_SLUG, "-").replace(/^-/, "").replace(/-$/, "");
  if (slug === "") {
    throw new Error(`cannot derive a branch name from the git author email ${JSON.stringify(email)}`);
  }
  return slug;
}

/** `pattern` is config's `git.branch_pattern`, which carries `{author_slug}`. */
export function branchFor(pattern: string, email: string): string {
  return pattern.replaceAll(AUTHOR_SLUG_PLACEHOLDER, authorSlug(email));
}
