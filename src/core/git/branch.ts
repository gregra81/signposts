// The branch a developer's proposals land on: `signposts/<author-slug>/<date>`,
// derived from `git config user.email` (06-review-and-pr.md, "PR mechanics").
//
// Per developer, not per repo. Every teammate runs their own worker on their
// own machine, concurrently and unaware of each other; one shared branch turns
// that into push races and into reviewing proposals from sessions you were
// never present for.
//
// Per *cycle* rather than for ever, which is what the date is for. Sessions
// accumulate onto the branch that already has an open pull request, so a week
// of runs is still one review. But a branch reused past its own merge never
// picks the base branch back up — nothing here rebases onto main — so it
// drifts further from the merged corpus every cycle, and `applyOperations`
// starts skipping ids it can see in the mirror and not on the branch. Once the
// pull request is merged the branch has done its job; the next session starts a
// new one from the base.
//
// Pure: the pattern, an email, today's date and what the forge already knows
// about this developer's branches go in, and the branch to commit on comes
// out. Reading the email and asking the forge are git's business (src/io/).

const AUTHOR_SLUG_PLACEHOLDER = "{author_slug}";
const DATE_PLACEHOLDER = "{date}";

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

/**
 * `pattern` is config's `git.branch_pattern`, which carries `{author_slug}`
 * and `{date}`. `date` is an ISO calendar date from the injected clock.
 */
export function branchFor(pattern: string, email: string, date: string): string {
  return pattern
    .replaceAll(AUTHOR_SLUG_PLACEHOLDER, authorSlug(email))
    .replaceAll(DATE_PLACEHOLDER, date);
}

/**
 * Everything in the branch name that does not change between cycles — what a
 * developer's branches can be recognised by.
 *
 * A pattern with no `{date}` in it has no varying part, so its prefix is the
 * whole name. Such a branch still cycles — the rule is the merge, not the name
 * — and `pickBranch` falls through to the numeric suffix for the second cycle:
 * `knowledge/greg`, then `knowledge/greg-2`. Someone who configured the
 * pattern that way gets the cycle without the date in it, which is the part
 * they said they did not want.
 */
export function branchPrefix(pattern: string, email: string): string {
  const [beforeDate] = pattern.split(DATE_PLACEHOLDER);
  return beforeDate!.replaceAll(AUTHOR_SLUG_PLACEHOLDER, authorSlug(email));
}

/** A branch the forge has a pull request for, and whether that PR is still open. */
export interface KnownBranch {
  branch: string;
  open: boolean;
}

export interface PickBranchInput {
  pattern: string;
  email: string;
  /** Today, ISO calendar date, from the injected clock. */
  date: string;
  /** This developer's branches the forge knows a PR for, newest first. */
  known: readonly KnownBranch[];
}

/**
 * The branch this session should commit on: the one under review, or a new one.
 *
 * Reuse is decided by the pull request rather than by the branch existing,
 * because a merged branch still exists — locally, and usually on the remote
 * too. `known` is what the forge reports, so a branch nobody has opened a PR
 * for is not in it: an earlier session pushed and could not reach the forge,
 * and today's name is minted again, which is the same branch and the right
 * place for it.
 *
 * The suffix is for the cycle that turns over on the day it opened. Merge at
 * noon, run again after lunch, and today's date names the branch that has just
 * been merged — whose tip is the corpus as it was this morning. `-2` is a new
 * branch off the base, which is what a new cycle is.
 */
export function pickBranch(input: PickBranchInput): string {
  const prefix = branchPrefix(input.pattern, input.email);
  const mine = input.known.filter((candidate) => candidate.branch.startsWith(prefix));

  const underReview = mine.find((candidate) => candidate.open);
  if (underReview !== undefined) {
    return underReview.branch;
  }

  const taken = new Set(mine.map((candidate) => candidate.branch));
  const unsuffixed = branchFor(input.pattern, input.email, input.date);

  // The unsuffixed name is the first cycle, so the second is `-2`, the way a
  // duplicated file is `name` and then `name-2`.
  let cycle = 1;
  let candidate = unsuffixed;
  while (taken.has(candidate)) {
    cycle += 1;
    candidate = `${unsuffixed}-${String(cycle)}`;
  }
  return candidate;
}
