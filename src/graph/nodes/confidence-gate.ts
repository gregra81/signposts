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
import { CLASSIFICATION_KINDS, RESOLUTION_OUTCOMES } from "../../core/contracts/graph.ts";
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

export function makeConfidenceGateNode(ports: GraphPorts) {
  return async function confidenceGateNode(state: ExtractionState): Promise<ExtractionUpdate> {
    const isBootstrap = await ports.index.isBootstrap(state.repo);

    return {
      gated: partitionOperations({
        built: state.validated,
        isBootstrap,
        unresolvedContradictions: unresolvedContradictions(state),
      }),
    };
  };
}
