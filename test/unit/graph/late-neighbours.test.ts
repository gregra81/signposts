// What counts as a neighbour `classify` should have been shown and was not.
// The graph-level consequence, a second classify that turns an `add` into a
// `reinforce`, is in test/behaviour/graph/overlapping-sessions.test.ts.

import { describe, expect, it } from "vitest";
import { addingCandidates, lateNeighbourTargets } from "../../../src/core/graph/late-neighbours.js";
import { existingSignpost, graphState } from "../../behaviour/helpers/graph-harness.js";
import type { CandidateOperations, NeighbourSignpost } from "../../../src/core/contracts/graph.js";

const SESSION = graphState().sessionId;

const MERGED: NeighbourSignpost = existingSignpost({ id: "staging-read-only" });
const OTHER_SESSION: NeighbourSignpost = {
  ...existingSignpost({
    id: "no-writes-to-staging",
    provenance: {
      session_ids: ["sess-other"],
      authors: ["dev@acme.example"],
      first_seen: "2026-08-27",
      last_reinforced: "2026-08-27",
    },
  }),
  pending: "in_pr",
};
const THIS_SESSION: NeighbourSignpost = {
  ...OTHER_SESSION,
  id: "staging-is-read-only",
  provenance: { ...OTHER_SESSION.provenance, session_ids: [SESSION] },
};

describe("addingCandidates", () => {
  it("names only the candidates that would create a signpost", () => {
    const validated: CandidateOperations[] = [
      { tempId: "t1", confidence: 0.9, operations: [{ op: "add", signpost: OTHER_SESSION }] },
      {
        tempId: "t2",
        confidence: 0.9,
        operations: [{ op: "reinforce", id: "staging-read-only", sessionId: SESSION, author: "a" }],
      },
    ];

    expect(addingCandidates(validated)).toEqual(["t1"]);
  });
});

describe("lateNeighbourTargets", () => {
  it("flags a pending neighbour from another session that classify was not shown", () => {
    expect(
      lateNeighbourTargets({ seen: { t1: [] }, fresh: { t1: [OTHER_SESSION] }, sessionId: SESSION }),
    ).toEqual(["t1"]);
  });

  it("ignores a pending neighbour classify already judged", () => {
    expect(
      lateNeighbourTargets({
        seen: { t1: [OTHER_SESSION] },
        fresh: { t1: [OTHER_SESSION] },
        sessionId: SESSION,
      }),
    ).toEqual([]);
  });

  it("ignores a merged neighbour that ranked in on the second query", () => {
    expect(
      lateNeighbourTargets({ seen: { t1: [] }, fresh: { t1: [MERGED] }, sessionId: SESSION }),
    ).toEqual([]);
  });

  it("ignores this session's own proposal", () => {
    expect(
      lateNeighbourTargets({ seen: { t1: [] }, fresh: { t1: [THIS_SESSION] }, sessionId: SESSION }),
    ).toEqual([]);
  });

  it("treats a candidate with no recorded neighbours as having been shown none", () => {
    expect(
      lateNeighbourTargets({ seen: {}, fresh: { t1: [OTHER_SESSION] }, sessionId: SESSION }),
    ).toEqual(["t1"]);
  });
});
