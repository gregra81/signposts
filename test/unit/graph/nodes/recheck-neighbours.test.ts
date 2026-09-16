// Node 7b's three decisions, none of which src/core/graph/late-neighbours.ts
// makes: which candidates are asked again, which of the answers routes back to
// `classify`, and what that second `classify` is shown.
//
// The node was covered only end to end (test/behaviour/graph/overlapping-sessions.test.ts),
// through a run with one candidate. One candidate cannot tell "the ones that
// would add" from "all of them", and a run that routes everything back cannot
// tell "the stale ones" from "the ones we asked about" — so all three filters
// could be deleted with the suite green. This file is the narrow half.

import { describe, expect, it } from "vitest";
import { Send } from "@langchain/langgraph";
import { makeRecheckNeighboursNode } from "../../../../src/graph/nodes/recheck-neighbours.js";
import { NODE_IDS } from "../../../../src/graph/node-ids.js";
import {
  AUTHOR,
  candidate,
  existingSignpost,
  graphState,
  gutteredSession,
  makeHarness,
  RUN_INPUT,
  type Harness,
} from "../../../behaviour/helpers/graph-harness.js";
import type { CandidateOperations, NeighbourSignpost } from "../../../../src/core/contracts/graph.js";
import type { Candidate } from "../../../../src/core/contracts/graph.js";

/** What another session proposed while this one sat on a `classify` halt. */
const LATE = existingSignpost({
  id: "no-writes-to-staging-outside-etl",
  claim: "You cannot write to staging except during the ETL window",
  provenance: {
    session_ids: ["sess-other"],
    authors: [AUTHOR],
    first_seen: "2026-08-27",
    last_reinforced: "2026-08-27",
  },
});

const adds = (tempId: string): CandidateOperations => ({
  tempId,
  confidence: 0.9,
  operations: [{ op: "add", signpost: existingSignpost({ id: `${tempId}-proposed` }) }],
});

const reinforces = (tempId: string): CandidateOperations => ({
  tempId,
  confidence: 0.9,
  operations: [{ op: "reinforce", id: "staging-writable", sessionId: RUN_INPUT.sessionId, author: AUTHOR }],
});

function named(tempId: string): Candidate {
  return candidate({ tempId, claim: `Claim for ${tempId}` });
}

/**
 * Runs the node over `validated`, with `LATE` already in the pending index —
 * so every candidate retrieval is asked about comes back paired with it, and
 * `seen` is the only thing that decides which of them is stale.
 */
async function recheck(input: {
  candidates: readonly Candidate[];
  validated: readonly CandidateOperations[];
  seen?: Record<string, NeighbourSignpost[]>;
}): Promise<{ command: Awaited<ReturnType<ReturnType<typeof makeRecheckNeighboursNode>>>; ports: Harness }> {
  const ports = makeHarness({ script: {}, session: gutteredSession() });
  await ports.pendingIndex.indexPending(RUN_INPUT.repo, [{ signpost: LATE, state: "in_pr" }]);

  const state = graphState({
    candidates: [...input.candidates],
    validated: [...input.validated],
    neighbours: input.seen ?? {},
  });

  return { command: await makeRecheckNeighboursNode(ports)(state), ports };
}

/** The tempIds a `Command`'s `goto` sends back to `classify`. */
function sentTo(goto: unknown): string[] {
  return (goto as Send[]).map((send) => (send.args as { candidate: Candidate }).candidate.tempId);
}

describe("which candidates are asked again", () => {
  it("asks only about the ones that would add", async () => {
    const { ports } = await recheck({
      candidates: [named("t1"), named("t2")],
      validated: [adds("t1"), reinforces("t2")],
    });

    // t2's operation acts on a signpost that already exists, so a neighbour
    // arriving late cannot make it a duplicate of anything.
    expect(ports.neighbours.calls).toEqual(["t1"]);
  });

  it("asks about none of them when nothing would add", async () => {
    const { command, ports } = await recheck({
      candidates: [named("t1")],
      validated: [reinforces("t1")],
    });

    expect(ports.neighbours.calls).toEqual([]);
    expect(command.goto).toEqual([NODE_IDS.confidenceGate]);
  });
});

describe("which answers route back to classify", () => {
  it("sends back only the candidate the late neighbour is news to", async () => {
    const { command, ports } = await recheck({
      candidates: [named("t1"), named("t2")],
      validated: [adds("t1"), adds("t2")],
      // t2 was classified against it already; t1 was not.
      seen: { t2: [{ ...LATE, pending: "in_pr" }] },
    });

    expect(ports.neighbours.calls).toEqual(["t1", "t2"]);
    expect(sentTo(command.goto)).toEqual(["t1"]);
  });

  it("goes straight to the gate when every adding candidate had already seen it", async () => {
    const { command } = await recheck({
      candidates: [named("t1")],
      validated: [adds("t1")],
      seen: { t1: [{ ...LATE, pending: "in_pr" }] },
    });

    expect(command.goto).toEqual([NODE_IDS.confidenceGate]);
    expect(command.update).toBeUndefined();
  });
});

describe("what the second classify is shown", () => {
  it("rewrites neighbours with the fresh list, for the stale candidates only", async () => {
    const { command } = await recheck({
      candidates: [named("t1"), named("t2")],
      validated: [adds("t1"), adds("t2")],
      seen: { t2: [{ ...LATE, pending: "in_pr" }] },
    });

    // Only t1's entry, and carrying the neighbour `classify` never saw —
    // the channel this writes is what ends the loop, so an empty update
    // would send the same candidate back for ever.
    expect(command.update).toEqual({
      neighbours: { t1: [{ ...LATE, pending: "in_pr" }] },
    });
  });

  it("hands classify the same fresh list it wrote to the channel", async () => {
    const { command } = await recheck({
      candidates: [named("t1")],
      validated: [adds("t1")],
    });

    const sends = command.goto as Send[];
    expect(sends).toHaveLength(1);
    expect(sends[0]!.node).toBe(NODE_IDS.classify);
    expect(sends[0]!.args).toEqual({
      repo: RUN_INPUT.repo,
      candidate: named("t1"),
      neighbours: [{ ...LATE, pending: "in_pr" }],
    });
  });
});
