// Node 8, `confidence_gate` (04-extraction-graph.md): partitions the
// validated operations into `auto` and `needsHuman`, producing
// 12-wire-contracts.md's `GatedOperations`.
//
// The routing decision itself is ./gate.ts and is not duplicated here — this
// module calls it, then attaches the GateReason that `gate()` deliberately
// does not return. The two are separate because the decision is a truth table
// over the policy in 06-review-and-pr.md, while the reason is a message to a
// human reviewer: getting the reason wrong is a worse explanation, not a
// worse routing.
//
// PURE. Bootstrap state is read from the database by the caller and arrives
// here as a plain boolean, exactly as it does for gate().

import { BOOTSTRAP_GATE_ALL } from "../config/constants.ts";
import {
  GATE_REASONS,
  OPERATION_TAGS,
  type CandidateOperations,
  type GatedOperations,
  type GateReason,
  type Operation,
} from "../contracts/graph.ts";
import { gate } from "./gate.ts";

export interface PartitionInput {
  /** Validated operations, grouped by the candidate that produced them. */
  built: readonly CandidateOperations[];
  isBootstrap: boolean;
  /**
   * tempIds whose contradiction `resolve_conflict` could not settle. Their
   * operations always route to a human under `unresolved_contradiction` —
   * 04-extraction-graph.md: "A candidate contradicting an existing signpost
   * never reaches `commit` without a human decision."
   */
  unresolvedContradictions: ReadonlySet<string>;
}

export function partitionOperations({
  built,
  isBootstrap,
  unresolvedContradictions,
}: PartitionInput): GatedOperations {
  const auto: Operation[] = [];
  const needsHuman: { operation: Operation; reason: GateReason }[] = [];

  for (const candidate of built) {
    const unresolved = unresolvedContradictions.has(candidate.tempId);

    for (const operation of candidate.operations) {
      // An unresolved contradiction bypasses the confidence test entirely: a
      // high-confidence claim that contradicts recorded knowledge is exactly
      // the case that must not auto-publish.
      if (unresolved) {
        needsHuman.push({ operation, reason: GATE_REASONS.unresolved_contradiction });
        continue;
      }

      if (gate(operation, candidate.confidence, isBootstrap) === "auto") {
        auto.push(operation);
        continue;
      }

      needsHuman.push({ operation, reason: reasonFor(operation, isBootstrap) });
    }
  }

  return { auto, needsHuman };
}

/**
 * Why this operation stopped, most specific cause first.
 *
 * What the operation *does* outranks the run being a bootstrap, because
 * "this deletes existing knowledge" stays the useful thing to tell a
 * reviewer even on the first run. Bootstrap outranks low confidence for the
 * opposite reason: during a bootstrap run a perfectly confident `add` is
 * still held back, and calling that "low confidence" would be false.
 *
 * Only called for an operation gate() already routed to a human, which is why
 * the fallback is `low_confidence`: with the op-kind and bootstrap cases
 * already returned above, an `add` or `reinforce` that still needs a human
 * got there by failing AUTO_PUBLISH_CONFIDENCE and no other way.
 */
export function reasonFor(operation: Operation, isBootstrap: boolean): GateReason {
  if (operation.op === OPERATION_TAGS.retire) {
    return GATE_REASONS.deletes_existing;
  }
  if (operation.op === OPERATION_TAGS.refine || operation.op === OPERATION_TAGS.supersede) {
    return GATE_REASONS.edits_existing;
  }
  if (isBootstrap && BOOTSTRAP_GATE_ALL) {
    return GATE_REASONS.bootstrap_run;
  }
  return GATE_REASONS.low_confidence;
}
