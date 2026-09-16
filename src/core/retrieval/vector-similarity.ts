// What sqlite-vec's `distance` column means, stated once.
//
// `vec0` ranks on squared-free L2 (euclidean) distance, and the embedder
// (../../io/embed/embedder.ts) runs the feature-extraction pipeline with
// `normalize: true`, so every stored and every query vector is unit-length.
// For unit vectors the two metrics are the same ordering and an exact
// conversion:
//
//   d² = |a - b|² = |a|² + |b|² - 2a·b = 2 - 2cos
//   cos = 1 - d²/2
//
// This exists because the read path needs a number it can threshold on and the
// RRF score is not one (19-value-to-a-user.md item 8). A fused rank score says
// where a row came in the list; it says nothing about whether the list was
// worth returning, which is why a question about sourdough came back with five
// rows scored inside a factor of two of a genuine hit.
//
// It is only valid for unit-length vectors. If the embedder ever stops
// normalising, this silently starts lying rather than throwing, so the
// `normalize: true` in the pipeline options is load-bearing and is commented
// as such there.

/** Cosine similarity of two unit vectors, from the L2 distance `vec0` reports. */
export function cosineFromL2Distance(distance: number): number {
  // The 2 is the one in `cos = 1 - d²/2`, a term of the identity above. It
  // collides with MAX_EXTRACT_ATTEMPTS and MAX_VALIDATE_ATTEMPTS, which have
  // nothing to do with vectors, and naming it locally does not help — the
  // declaration is a literal too. Same shape as the disable in
  // src/cli/commands/mcp.ts.
  // eslint-disable-next-line signposts/no-magic-literal -- coincidental collision; see above
  return 1 - (distance * distance) / 2;
}
