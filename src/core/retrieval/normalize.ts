// Pure normalisation applied to a signpost's `claim` before embedding
// (05-retrieval.md "Embed the `claim` field only... Normalise before
// embedding: lowercase, collapse whitespace, strip trailing punctuation").
// No IO — this is Slice A core, mutation-graded.

/** Trailing run of punctuation/whitespace, stripped after lowercasing and collapsing. */
const TRAILING_PUNCTUATION_RE = /[\s.,!?;:]+$/;

const INTERNAL_WHITESPACE_RE = /\s+/g;

/**
 * lowercase -> collapse internal whitespace to a single space -> strip
 * trailing punctuation -> trim. Order matches 05-retrieval.md's list.
 *
 * One trim, at the end: collapsing never removes edge whitespace (a run of
 * N >= 1 becomes a single space, not zero), and TRAILING_PUNCTUATION_RE's
 * character class already includes `\s`, so it consumes any trailing
 * whitespace along with trailing punctuation. Only a leading space can
 * survive to this point, which the final `.trim()` removes.
 */
export function normalize(claim: string): string {
  const collapsed = claim.toLowerCase().replace(INTERNAL_WHITESPACE_RE, " ");
  return collapsed.replace(TRAILING_PUNCTUATION_RE, "").trim();
}
