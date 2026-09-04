// What one session's proposals contribute to the index before the next
// session in the same run is processed (06-review-and-pr.md, "Reindex within
// a run, not only at commit").
//
// Both halves of the gate's partition count. `auto` is proposed and unmerged;
// so is `needsHuman`, which is if anything the half that most needs to be
// visible, since a person may sit on it for days while later sessions keep
// proposing against a corpus that pretends it does not exist.
//
// Only the operations that introduce a signpost yield one: `add` and the
// replacement on `supersede`. The others are deliberately absent, and not by
// oversight — `reinforce` only appends provenance to a row the index already
// has, `retire` removes one, and `refine` carries a patch rather than a
// signpost, so the merged text it would index is not on the operation. A
// refined claim therefore stays retrievable as the text it currently has,
// which is what is on disk and still true until the PR lands.
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
    } else if (operation.op === OPERATION_TAGS.supersede) {
      signposts.push(operation.replacement);
    }
  }

  return signposts;
}
