// Which candidates `classify` judged against a neighbour list that has since
// gone out of date (06-review-and-pr.md, "Sessions that overlap").
//
// The reindex within a run makes session N+1 retrieve against session N's
// proposals, but only when N has settled before N+1 retrieves. Nothing makes
// that order hold. A skill driving two sessions at once breaks it: both
// retrieve, both find nothing, both classify NOVEL, and the pull request
// carries the same claim twice. That is how gregra81/earnest got two signposts
// for its production URL, committed thirteen seconds apart by sessions run in
// parallel.
//
// `recheck_neighbours` asks retrieval again once classification is done, and
// this decides what the answer means. A candidate is classified again when
// retrieval now returns a pending neighbour it was not shown: another session
// proposed something in the meantime. Three things do not count:
//
//   - a neighbour it was shown, which `classify` has already judged;
//   - a merged neighbour, because the merged corpus is synced once, at
//     `run --first`, so one turning up mid-run is ranking and not news;
//   - a pending neighbour this session proposed itself, which a session re-run
//     from its transcript finds in the index.
//
// Only candidates that would `add` are asked about. Every other operation acts
// on a signpost that already exists, and a duplicate needs a new file.
//
// PURE.

import {
  OPERATION_TAGS,
  type CandidateOperations,
  type NeighbourSignpost,
} from "../contracts/graph.ts";

/** tempIds of the candidates whose operations include an `add`, in `validated` order. */
export function addingCandidates(validated: readonly CandidateOperations[]): string[] {
  return validated
    .filter((candidate) => candidate.operations.some((operation) => operation.op === OPERATION_TAGS.add))
    .map((candidate) => candidate.tempId);
}

export interface LateNeighbourInput {
  /** What each candidate was classified against: the `neighbours` channel. */
  seen: Readonly<Record<string, readonly NeighbourSignpost[]>>;
  /** What retrieval returns now, for the candidates that were asked about. */
  fresh: Readonly<Record<string, readonly NeighbourSignpost[]>>;
  sessionId: string;
}

/** tempIds retrieval now pairs with a pending neighbour from another session, unseen by `classify`. */
export function lateNeighbourTargets({ seen, fresh, sessionId }: LateNeighbourInput): string[] {
  return Object.entries(fresh)
    .filter(([tempId, neighbours]) => {
      const shown = new Set((seen[tempId] ?? []).map((neighbour) => neighbour.id));
      return neighbours.some(
        (neighbour) =>
          neighbour.pending !== undefined &&
          !shown.has(neighbour.id) &&
          !neighbour.provenance.session_ids.includes(sessionId),
      );
    })
    .map(([tempId]) => tempId);
}
