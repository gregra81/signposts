// Node 8, `confidence_gate` — deterministic. The routing rule.
//
// Partitions the validated operations into `auto` and `needsHuman`
// (06-review-and-pr.md's policy, applied by src/core/gate/). Mechanically it
// decides nothing about content — it only decides who sees an operation next.
//
// The unresolved contradictions are recomputed here from `classifications`
// and `resolutions` rather than carried along, because both are already in
// state and a derived value cannot drift from the two channels it is derived
// from.

import { partitionOperations } from "../../core/gate/partition.ts";
import { CLASSIFICATION_KINDS, PENDING_STATES, RESOLUTION_OUTCOMES } from "../../core/contracts/graph.ts";
import type { ExtractionState, ExtractionUpdate } from "../state.ts";
import type { GraphPorts } from "../ports.ts";

/**
 * tempIds classified CONTRADICTION that `resolve_conflict` did not settle —
 * either it returned `undecidable`, or it never ran for that candidate (the
 * existing claim could not be looked up). Both mean the same thing
 * downstream: a person decides.
 */
export function unresolvedContradictions(state: ExtractionState): Set<string> {
  const unresolved = new Set<string>();
  for (const [tempId, classification] of Object.entries(state.classifications)) {
    if (classification.kind !== CLASSIFICATION_KINDS.CONTRADICTION) {
      continue;
    }
    const resolution = state.resolutions[tempId];
    if (resolution === undefined || resolution.outcome === RESOLUTION_OUTCOMES.undecidable) {
      unresolved.add(tempId);
    }
  }
  return unresolved;
}

/**
 * tempIds whose classification named a neighbour a person is still holding —
 * proposed by an earlier session in this run and gated for review
 * (06-review-and-pr.md, "Reindex within a run").
 *
 * A neighbour pending as `in_pr` is not one of them. That proposal cleared the
 * gate and this session's predecessor has already committed it, so an
 * operation against it lands in the same pull request and needs no second
 * opinion. Only `awaiting_review` can still be rejected out from under it.
 *
 * Derived here from `neighbours` and `classifications` for the same reason
 * `unresolvedContradictions` is: both channels are already in state, and a
 * value derived on the spot cannot drift from what it was derived from.
 */
export function pendingNeighbourTargets(state: ExtractionState): Set<string> {
  const targets = new Set<string>();
  for (const [tempId, classification] of Object.entries(state.classifications)) {
    // NOVEL needs no special case: it carries no relatedId, and no signpost id
    // is undefined, so the lookup finds nothing.
    const named = state.neighbours[tempId]?.find(
      (neighbour) => neighbour.id === classification.relatedId,
    );
    if (named?.pending === PENDING_STATES.awaiting_review) {
      targets.add(tempId);
    }
  }
  return targets;
}

export function makeConfidenceGateNode(ports: GraphPorts) {
  return async function confidenceGateNode(state: ExtractionState): Promise<ExtractionUpdate> {
    const isBootstrap = await ports.index.isBootstrap(state.repo);

    return {
      gated: partitionOperations({
        built: state.validated,
        isBootstrap,
        unresolvedContradictions: unresolvedContradictions(state),
        pendingNeighbourTargets: pendingNeighbourTargets(state),
      }),
    };
  };
}
