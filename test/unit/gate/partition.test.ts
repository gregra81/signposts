import { describe, expect, it } from "vitest";
import { partitionOperations, reasonFor } from "../../../src/core/gate/partition.js";
import { AUTO_PUBLISH_CONFIDENCE } from "../../../src/core/config/constants.js";
import type { CandidateOperations, Operation } from "../../../src/core/contracts/graph.js";
import type { Signpost } from "../../../src/core/signpost/schema.js";

const ABOVE = AUTO_PUBLISH_CONFIDENCE;
const BELOW = AUTO_PUBLISH_CONFIDENCE - 0.01;
const NONE = new Set<string>();

function signpost(id = "new-claim"): Signpost {
  return {
    id,
    claim: "A durable claim",
    category: "preference",
    scope: { repo: "acme/api" },
    evidence: "Stated by the human.",
    confidence: 0.9,
    provenance: {
      session_ids: ["s1"],
      authors: ["dev@acme.example"],
      first_seen: "2026-08-27",
      last_reinforced: "2026-08-27",
    },
    status: "active",
  };
}

const ADD: Operation = { op: "add", signpost: signpost() };
const REINFORCE: Operation = { op: "reinforce", id: "known", sessionId: "s1", author: "a@b.c" };
const REFINE: Operation = { op: "refine", id: "known", claim: "Sharper" };
const SUPERSEDE: Operation = { op: "supersede", id: "known", replacement: signpost("newer") };
const RETIRE: Operation = { op: "retire", id: "known", reason: "obsolete" };

function group(operations: Operation[], confidence: number, tempId = "t1"): CandidateOperations {
  return { tempId, confidence, operations };
}

describe("partitionOperations", () => {
  it("auto-publishes a confident add outside bootstrap", () => {
    const result = partitionOperations({
      built: [group([ADD], ABOVE)],
      isBootstrap: false,
      unresolvedContradictions: NONE,
      pendingNeighbourTargets: NONE,
    });
    expect(result).toEqual({ auto: [ADD], needsHuman: [] });
  });

  it("holds back a low-confidence add as low_confidence", () => {
    const result = partitionOperations({
      built: [group([ADD], BELOW)],
      isBootstrap: false,
      unresolvedContradictions: NONE,
      pendingNeighbourTargets: NONE,
    });
    expect(result.auto).toEqual([]);
    expect(result.needsHuman).toEqual([{ operation: ADD, reason: "low_confidence" }]);
  });

  it("holds back everything during a bootstrap run", () => {
    const result = partitionOperations({
      built: [group([ADD, REINFORCE], ABOVE)],
      isBootstrap: true,
      unresolvedContradictions: NONE,
      pendingNeighbourTargets: NONE,
    });
    expect(result.auto).toEqual([]);
    expect(result.needsHuman.map((entry) => entry.reason)).toEqual([
      "bootstrap_run",
      "bootstrap_run",
    ]);
  });

  it("auto-publishes a reinforce whatever its confidence", () => {
    const result = partitionOperations({
      built: [group([REINFORCE], BELOW)],
      isBootstrap: false,
      unresolvedContradictions: NONE,
      pendingNeighbourTargets: NONE,
    });
    expect(result.auto).toEqual([REINFORCE]);
  });

  it.each([
    ["refine", REFINE, "edits_existing"],
    ["supersede", SUPERSEDE, "edits_existing"],
    ["retire", RETIRE, "deletes_existing"],
  ])("always routes %s to a human", (_name, operation, reason) => {
    const result = partitionOperations({
      built: [group([operation], ABOVE)],
      isBootstrap: false,
      unresolvedContradictions: NONE,
      pendingNeighbourTargets: NONE,
    });
    expect(result.auto).toEqual([]);
    expect(result.needsHuman).toEqual([{ operation, reason }]);
  });

  // 04's acceptance criterion: a contradicting candidate never reaches commit
  // without a human decision — confidence is not allowed to override that.
  it("routes a confident operation from an unresolved contradiction to a human", () => {
    const result = partitionOperations({
      built: [group([ADD], ABOVE, "t1")],
      isBootstrap: false,
      unresolvedContradictions: new Set(["t1"]),
      pendingNeighbourTargets: NONE,
    });
    expect(result.auto).toEqual([]);
    expect(result.needsHuman).toEqual([
      { operation: ADD, reason: "unresolved_contradiction" },
    ]);
  });

  it("leaves other candidates unaffected by one unresolved contradiction", () => {
    const result = partitionOperations({
      built: [group([ADD], ABOVE, "t1"), group([REINFORCE], ABOVE, "t2")],
      isBootstrap: false,
      unresolvedContradictions: new Set(["t1"]),
      pendingNeighbourTargets: NONE,
    });
    expect(result.auto).toEqual([REINFORCE]);
    expect(result.needsHuman).toHaveLength(1);
  });

  // A candidate's operations are one package. `both_scoped` emits a refine of
  // the old signpost plus an add of the new one; auto-publishing the add while
  // a person still holds the refine leaves the repo carrying the unnarrowed
  // old claim beside the new one.
  it("holds every operation of a multi-operation candidate when one needs a human", () => {
    const result = partitionOperations({
      built: [group([REFINE, ADD], ABOVE)],
      isBootstrap: false,
      unresolvedContradictions: NONE,
      pendingNeighbourTargets: NONE,
    });
    expect(result.auto).toEqual([]);
    expect(result.needsHuman).toEqual([
      { operation: REFINE, reason: "edits_existing" },
      { operation: ADD, reason: "edits_existing" },
    ]);
  });

  it("holds the package whichever operation in it needs the human", () => {
    const result = partitionOperations({
      built: [group([ADD, REFINE], ABOVE)],
      isBootstrap: false,
      unresolvedContradictions: NONE,
      pendingNeighbourTargets: NONE,
    });
    expect(result.auto).toEqual([]);
    expect(result.needsHuman).toHaveLength(2);
  });

  it("auto-publishes every operation of a multi-operation candidate when none needs a human", () => {
    const result = partitionOperations({
      built: [group([ADD, REINFORCE], ABOVE)],
      isBootstrap: false,
      unresolvedContradictions: NONE,
      pendingNeighbourTargets: NONE,
    });
    expect(result.auto).toEqual([ADD, REINFORCE]);
    expect(result.needsHuman).toEqual([]);
  });

  // A reinforce is provenance-only and normally auto-publishes. Against a
  // proposal from earlier in this same run it must not: the person holding
  // that proposal may reject it, and the reinforce would have published a
  // reference to a signpost that never existed.
  it("holds back an operation targeting a neighbour this run only proposed", () => {
    const result = partitionOperations({
      built: [group([REINFORCE], ABOVE)],
      isBootstrap: false,
      unresolvedContradictions: NONE,
      pendingNeighbourTargets: new Set(["t1"]),
    });
    expect(result.auto).toEqual([]);
    expect(result.needsHuman).toEqual([{ operation: REINFORCE, reason: "pending_neighbour" }]);
  });

  it("reports an unresolved contradiction ahead of a pending target", () => {
    const result = partitionOperations({
      built: [group([ADD], ABOVE)],
      isBootstrap: false,
      unresolvedContradictions: new Set(["t1"]),
      pendingNeighbourTargets: new Set(["t1"]),
    });
    expect(result.needsHuman).toEqual([
      { operation: ADD, reason: "unresolved_contradiction" },
    ]);
  });

  it("leaves an operation against a merged neighbour alone", () => {
    const result = partitionOperations({
      built: [group([REINFORCE], ABOVE)],
      isBootstrap: false,
      unresolvedContradictions: NONE,
      pendingNeighbourTargets: new Set(["t2"]),
    });
    expect(result.auto).toEqual([REINFORCE]);
  });

  it("produces an empty partition for an empty batch", () => {
    expect(
      partitionOperations({
        built: [],
        isBootstrap: false,
        unresolvedContradictions: NONE,
        pendingNeighbourTargets: NONE,
      }),
    ).toEqual({ auto: [], needsHuman: [] });
  });
});

describe("reasonFor", () => {
  // What the operation does outranks the run being a bootstrap: "this deletes
  // existing knowledge" stays the useful thing to tell a reviewer.
  it.each([
    ["retire", RETIRE, "deletes_existing"],
    ["refine", REFINE, "edits_existing"],
    ["supersede", SUPERSEDE, "edits_existing"],
  ])("reports what a %s does even during bootstrap", (_name, operation, expected) => {
    expect(reasonFor(operation, true)).toBe(expected);
  });

  it("reports bootstrap_run for an add on the first run", () => {
    expect(reasonFor(ADD, true)).toBe("bootstrap_run");
  });

  it("reports low_confidence for an add outside bootstrap", () => {
    expect(reasonFor(ADD, false)).toBe("low_confidence");
  });

  it("reports low_confidence for a reinforce outside bootstrap", () => {
    expect(reasonFor(REINFORCE, false)).toBe("low_confidence");
  });
});
