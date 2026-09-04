// What one session's proposals contribute to the index before the next
// session in the same run is processed (06-review-and-pr.md, "Reindex within
// a run, not only at commit").
//
// Both halves of the gate's partition count. `auto` is proposed and unmerged;
// so is `needsHuman`, which is if anything the half that most needs to be
// visible, since a person may sit on it for days while later sessions keep
// proposing against a corpus that pretends it does not exist.
//
// Only `add` yields one, and every other operation is deliberately absent.
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

import { OPERATION_TAGS, type GatedOperations } from "../contracts/graph.ts";
import type { Signpost } from "../signpost/schema.ts";

/** The signposts this session proposed, in gate order — auto first, then gated. */
export function pendingSignposts(gated: GatedOperations): Signpost[] {
  const proposed = [...gated.auto, ...gated.needsHuman.map(({ operation }) => operation)];
  const signposts: Signpost[] = [];

  for (const operation of proposed) {
    if (operation.op === OPERATION_TAGS.add) {
      signposts.push(operation.signpost);
    }
  }

  return signposts;
}
