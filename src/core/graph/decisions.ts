// Node 9's output applied to node 8's partition: which operations `commit`
// actually gets, once a human has answered.
//
// `humanDecisions` is a Record keyed by an operation key derived from the
// operation itself (see `operationKey`) rather than by array index. The key
// has to survive a checkpoint round-trip and a process restart — a person may
// answer three days later, from a different process — and an index is only
// meaningful relative to a list that was in memory at the time. A derived key
// is reconstructible from state alone, which is the same property that makes
// the thread id reconstructible (./thread-id.ts).
//
// PURE.

import { OPERATION_TAGS, type GatedOperations, type HumanDecision, type Operation } from "../contracts/graph.ts";

export const OPERATION_KEY_SEPARATOR = ":";

/**
 * A stable key for one operation within one run.
 *
 * `add` keys on the id of the signpost it would create; every other operation
 * keys on the id it targets. Both are unique within a run: `validate` rejects
 * a batch that targets a signpost twice, and slug generation refuses to hand
 * out an id already taken.
 */
export function operationKey(operation: Operation): string {
  const id = operation.op === OPERATION_TAGS.add ? operation.signpost.id : operation.id;
  return [operation.op, id].join(OPERATION_KEY_SEPARATOR);
}

/**
 * The operations `commit` applies: everything the gate auto-approved, plus
 * the human-gated ones a person accepted (or the replacement they edited it
 * into), in gate order.
 *
 * An operation with no decision is left out. Silence is not consent — an
 * undecided operation means the review is unfinished, and 06-review-and-pr.md
 * lets nothing merge automatically.
 */
export function applyDecisions(
  gated: GatedOperations,
  humanDecisions: Readonly<Record<string, HumanDecision>>,
): Operation[] {
  const applied: Operation[] = [...gated.auto];

  for (const { operation } of gated.needsHuman) {
    const decision = humanDecisions[operationKey(operation)];
    if (decision === undefined || decision.decision === "reject") {
      continue;
    }
    // An "edit" without a replacement fails the schema on parse, and one that
    // retargets is rejected by `retargetedEdits` before this runs, so `edited`
    // is either absent — meaning "accept", use the operation as proposed — or a
    // replacement for this very operation.
    applied.push(decision.edited ?? operation);
  }

  return applied;
}

/**
 * The decision keys whose `edited` replacement does not target what the key
 * names. Empty means every edit stayed within its own operation.
 *
 * An edit adjusts the *content* of the operation that was proposed, never what
 * it acts on: 06-review-and-pr.md's review prompt names the signpost in its
 * header and offers `[e]dit` on the replacement text, so the reviewer chooses
 * wording, not a target. Enforcing it here is what keeps `commit` from
 * receiving an operation pointing at a signpost that does not exist — `validate`
 * runs before the gate and never sees a human's replacement.
 *
 * The key is already `op:id`, so it carries the whole constraint: an edit is
 * in-bounds exactly when its own `operationKey` is the key it arrived under.
 */
export function retargetedEdits(
  humanDecisions: Readonly<Record<string, HumanDecision>>,
): string[] {
  const wrong: string[] = [];
  for (const [key, decision] of Object.entries(humanDecisions)) {
    if (decision.edited !== undefined && operationKey(decision.edited) !== key) {
      wrong.push(key);
    }
  }
  return wrong;
}

/** Whether every gated operation has been answered — the resume condition. */
export function isReviewComplete(
  gated: GatedOperations,
  humanDecisions: Readonly<Record<string, HumanDecision>>,
): boolean {
  return gated.needsHuman.every(({ operation }) => humanDecisions[operationKey(operation)] !== undefined);
}
