// What one session's proposals contribute to the index before the next
// session in the same run is processed (06-review-and-pr.md, "Reindex within
// a run, not only at commit").
//
// Both halves of the gate's partition count, and they are kept apart rather
// than merged into one list. `auto` has already been written into the branch
// by this session's `commit`, so an operation a later session derives from it
// may auto-publish too — both land in the same pull request. `needsHuman` has
// not: a person is holding it and may reject it, so anything derived from it
// waits for the same person (../gate/partition.ts's `pending_neighbour`).
// That distinction is the difference between a reindex that stops duplicates
// and one that launders an unreviewed claim into the branch.
//
// Only `add` yields a proposal, and every other operation is deliberately
// absent.
//
// `reinforce` only appends provenance to a row the index already has, `retire`
// removes one, and `refine` carries a patch rather than a signpost, so the
// merged text it would index is not on the operation. A refined claim
// therefore stays retrievable as the text it currently has, which is what is
// on disk and still true until the PR lands.
//
// `supersede` is the interesting exclusion. Indexing its replacement would put
// both halves of a contradiction in front of the next session: the replacement
// as pending, and the claim it replaces still active and unchanged until the
// PR merges. The two contradict each other by construction — that is what
// `supersede` means — so `classify` would return CONTRADICTION and spend a
// tool-using `resolve_conflict` call re-adjudicating a conflict this same run
// has already settled. Leaving the replacement out leaves the old claim
// retrievable on its own, which is what the disk still says.
//
// PURE.

import {
  OPERATION_TAGS,
  PENDING_STATES,
  type GatedOperations,
  type Operation,
  type PendingState,
} from "../contracts/graph.ts";
import type { Signpost } from "../signpost/schema.ts";

export interface PendingProposal {
  signpost: Signpost;
  /** Whether a person is still holding it — see the module comment. */
  state: PendingState;
}

/** The signposts this session proposed, in gate order — auto first, then gated. */
export function pendingProposals(gated: GatedOperations): PendingProposal[] {
  return [
    ...added(gated.auto, PENDING_STATES.in_pr),
    ...added(
      gated.needsHuman.map(({ operation }) => operation),
      PENDING_STATES.awaiting_review,
    ),
  ];
}

function added(operations: readonly Operation[], state: PendingState): PendingProposal[] {
  const proposals: PendingProposal[] = [];
  for (const operation of operations) {
    if (operation.op === OPERATION_TAGS.add) {
      proposals.push({ signpost: operation.signpost, state });
    }
  }
  return proposals;
}
