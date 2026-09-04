// Node 8's derived input: which contradictions are still open when the gate
// runs. Everything else about the partition is src/core/gate/partition.ts.

import { describe, expect, it } from "vitest";
import {
  makeConfidenceGateNode,
  pendingNeighbourTargets,
  unresolvedContradictions,
} from "../../../../src/graph/nodes/confidence-gate.js";
import {
  existingSignpost,
  gutteredSession,
  makeHarness,
  graphState,
} from "../../../behaviour/helpers/graph-harness.js";
import type { Classification, Resolution } from "../../../../src/core/contracts/graph.js";

const contradiction = (tempId: string): Classification => ({
  tempId,
  kind: "CONTRADICTION",
  relatedId: "staging-writable",
  rationale: "The recorded claim says the opposite.",
});

const resolved = (tempId: string, outcome: Resolution["outcome"]): Resolution => ({
  tempId,
  outcome,
  reasoning: "Adjudicated.",
});

describe("unresolvedContradictions", () => {
  it("includes a contradiction the resolver never answered", () => {
    const state = graphState({ classifications: { t1: contradiction("t1") } });

    expect([...unresolvedContradictions(state)]).toEqual(["t1"]);
  });

  it("includes one the resolver called undecidable", () => {
    const state = graphState({
      classifications: { t1: contradiction("t1") },
      resolutions: { t1: resolved("t1", "undecidable") },
    });

    expect([...unresolvedContradictions(state)]).toEqual(["t1"]);
  });

  it.each(["new_wins", "existing_wins", "both_scoped"] as const)(
    "excludes one the resolver settled as %s",
    (outcome) => {
      const state = graphState({
        classifications: { t1: contradiction("t1") },
        resolutions: { t1: resolved("t1", outcome) },
      });

      expect([...unresolvedContradictions(state)]).toEqual([]);
    },
  );

  it("ignores classifications that were never contradictions", () => {
    const state = graphState({
      classifications: {
        t1: { tempId: "t1", kind: "NOVEL", rationale: "New." },
        t2: { tempId: "t2", kind: "DUPLICATE", relatedId: "x", rationale: "Same." },
      },
    });

    expect([...unresolvedContradictions(state)]).toEqual([]);
  });
});

// The gate's other derived input: which candidates were classified against a
// neighbour this run only proposed. Their operations inherit that neighbour's
// review — see src/core/gate/partition.ts's `pending_neighbour`.
describe("pendingNeighbourTargets", () => {
  const duplicate = (relatedId: string): Classification => ({
    tempId: "t1",
    kind: "DUPLICATE",
    relatedId,
    rationale: "The same claim.",
  });

  const merged = existingSignpost({ id: "staging-writable" });
  const pending = { ...existingSignpost({ id: "staging-read-only" }), pending: true as const };

  it("includes a candidate matched against a pending neighbour", () => {
    const state = graphState({
      classifications: { t1: duplicate(pending.id) },
      neighbours: { t1: [merged, pending] },
    });

    expect([...pendingNeighbourTargets(state)]).toEqual(["t1"]);
  });

  it("excludes one matched against a merged neighbour", () => {
    const state = graphState({
      classifications: { t1: duplicate(merged.id) },
      neighbours: { t1: [merged, pending] },
    });

    expect([...pendingNeighbourTargets(state)]).toEqual([]);
  });

  // A NOVEL classification names nothing, so it targets nothing — even when a
  // pending neighbour was retrieved and rejected as unrelated.
  it("excludes a NOVEL candidate", () => {
    const state = graphState({
      classifications: { t1: { tempId: "t1", kind: "NOVEL", rationale: "New." } },
      neighbours: { t1: [pending] },
    });

    expect([...pendingNeighbourTargets(state)]).toEqual([]);
  });

  it("excludes a candidate whose neighbours were never retrieved", () => {
    const state = graphState({ classifications: { t1: duplicate(pending.id) } });

    expect([...pendingNeighbourTargets(state)]).toEqual([]);
  });
});

describe("the node", () => {
  it("asks the index whether this is the repo's first run", async () => {
    const ports = makeHarness({ script: {}, session: gutteredSession(), bootstrap: true });

    const update = await makeConfidenceGateNode(ports)(graphState());

    expect(update.gated).toEqual({ auto: [], needsHuman: [] });
  });
});
