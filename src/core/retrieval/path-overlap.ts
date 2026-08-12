// Pure path-overlap boost signal. See 05-retrieval.md "Filter before you
// search" (#3): path overlap is a boost only, never a hard filter — this
// function never excludes a candidate, it only produces a signal that
// combineScore adds to the fused RRF score, never a tie-break-only signal
// and never a filter.

/** Count of paths shared between a candidate's and a neighbour's scope. Boost only, not a filter. */
export function pathOverlapBoost(
  candidatePaths: readonly string[] | undefined,
  neighbourPaths: readonly string[] | undefined,
): number {
  if (!candidatePaths || !neighbourPaths) {
    return 0;
  }
  const neighbourSet = new Set(neighbourPaths);
  return candidatePaths.filter((path) => neighbourSet.has(path)).length;
}
