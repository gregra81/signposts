// Reindexing between the sessions of one run (06-review-and-pr.md, "Reindex
// within a run, not only at commit").
//
// The failure this is about is a cold-start one and it is silent: two
// sessions in the same run where the human taught the same lesson in
// different words. Process them against the index as it stood when the run
// began and both retrieve nothing, both classify NOVEL, and the PR carries
// two near-identical `add`s that no classifier ever compared against each
// other. Nothing errors; the corpus just quietly acquires a duplicate.
//
// The classify reply here is a function of the call rather than a literal,
// deliberately. Scripting "session two says DUPLICATE" would assert the
// outcome the test is supposed to be checking; scripting "say DUPLICATE if a
// neighbour actually came back" makes the assertion depend on whether session
// one's proposal was really indexed and really retrieved.

import { describe, expect, it } from "vitest";
import { runSessions } from "../../../src/graph/index.js";
import type { Operation } from "../../../src/core/contracts/graph.js";
import type { RunResult } from "../../../src/graph/index.js";
import {
  candidate,
  gutteredSession,
  makeGraph,
  RUN_INPUT,
  type RecordedCall,
  type Script,
} from "../helpers/graph-harness.js";

const SESSION_ONE = { ...RUN_INPUT, sessionId: "sess-1", contentHash: "hash-1" };
const SESSION_TWO = { ...RUN_INPUT, sessionId: "sess-2", contentHash: "hash-2" };

// The same lesson, in the words each session used.
const FIRST = candidate({
  tempId: "t1",
  claim: "Staging is read only outside the ETL window",
});
const SECOND = candidate({
  tempId: "t2",
  claim: "You cannot write to staging except during the ETL window",
});

function keep(tempId: string) {
  return { verdicts: [{ tempId, keep: true, reason: "durable" }] };
}

/** The tempId of the candidate this call is about, from its user turn. */
function tempIdOf(call: RecordedCall): string {
  return /"tempId":"([^"]+)"/.exec(call.user)?.[1] ?? "";
}

/** The id of the first neighbour the call carried, or undefined if it carried none. */
function neighbourIdOf(call: RecordedCall): string | undefined {
  // The candidate half of the turn has no `id` field (see classifyUserTurn),
  // so the first one belongs to a neighbour.
  return /"id":"([^"]+)"/.exec(call.user)?.[1];
}

/**
 * A classifier that reads its own input: same claim as a neighbour it was
 * shown means DUPLICATE, nothing retrieved means NOVEL.
 */
function classifyAgainstNeighbours(call: RecordedCall) {
  const relatedId = neighbourIdOf(call);
  return relatedId === undefined
    ? { tempId: tempIdOf(call), kind: "NOVEL", rationale: "nothing recorded is about this" }
    : { tempId: tempIdOf(call), kind: "DUPLICATE", relatedId, rationale: "the same lesson, reworded" };
}

const SCRIPT: Script = {
  extract: [{ candidates: [FIRST] }, { candidates: [SECOND] }],
  critic: [keep(FIRST.tempId), keep(SECOND.tempId)],
  classify: [classifyAgainstNeighbours],
};

function twoSessions(script: Script = SCRIPT) {
  return makeGraph({ script, session: gutteredSession() });
}

/** Everything a session proposed, both halves of the gate's partition. */
function proposals(result: RunResult): Operation[] {
  return [...result.state.gated.auto, ...result.state.gated.needsHuman.map((entry) => entry.operation)];
}

describe("reindexing between the sessions of one run", () => {
  it("proposes one add and one reinforce, never two adds", async () => {
    const { ports, checkpointer, graph } = twoSessions();

    const results = await runSessions(graph, checkpointer, ports, [SESSION_ONE, SESSION_TWO]);

    const operations = results.flatMap(proposals);
    expect(operations.map((operation) => operation.op)).toEqual(["add", "reinforce"]);

    const [added, reinforced] = operations;
    expect(reinforced).toMatchObject({
      op: "reinforce",
      id: added?.op === "add" ? added.signpost.id : "",
      sessionId: SESSION_TWO.sessionId,
    });
  });

  // Session one's add cleared the gate, so its commit already wrote it into
  // the branch. The reinforce lands in the same pull request and needs no
  // second opinion.
  it("commits both when the proposal it reinforces auto-published", async () => {
    const { ports, checkpointer, graph } = twoSessions();

    await runSessions(graph, checkpointer, ports, [SESSION_ONE, SESSION_TWO]);

    expect(ports.commit.operations.map((operation) => operation.op)).toEqual(["add", "reinforce"]);
  });

  it("indexes the first session's proposal before the second is processed", async () => {
    const { ports, checkpointer, graph } = twoSessions();

    await runSessions(graph, checkpointer, ports, [SESSION_ONE, SESSION_TWO]);

    // One call, not two: the second session proposed a `reinforce`, which
    // adds no signpost to index — it appends provenance to the row the first
    // session already put there.
    expect(ports.pendingIndex.indexed).toHaveLength(1);
    expect(ports.pendingIndex.indexed[0]).toMatchObject({ repo: SESSION_ONE.repo });
    expect(ports.pendingIndex.indexed[0]?.proposals).toEqual([
      { signpost: expect.objectContaining({ claim: FIRST.claim }), state: "in_pr" },
    ]);
  });

  it("clears whatever the previous run left pending before it starts", async () => {
    const { ports, checkpointer, graph } = twoSessions();

    await runSessions(graph, checkpointer, ports, [SESSION_ONE, SESSION_TWO]);

    expect(ports.pendingIndex.cleared).toEqual([RUN_INPUT.repo]);
  });

  // The laundering case. A reinforce is provenance-only and normally
  // auto-publishes; against a proposal a person is still holding it must not,
  // because they may reject it and the reinforce would then name a signpost
  // that never existed.
  it("holds back an operation against a proposal a person is still holding", async () => {
    const { ports, checkpointer, graph } = twoSessions({
      ...SCRIPT,
      // Below AUTO_PUBLISH_CONFIDENCE, so session one's add is gated and the
      // run halts on it.
      extract: [{ candidates: [{ ...FIRST, confidence: 0.5 }] }, { candidates: [SECOND] }],
    });

    const [first, second] = await runSessions(graph, checkpointer, ports, [SESSION_ONE, SESSION_TWO]);

    expect(first?.state.gated.needsHuman).toEqual([
      { operation: expect.objectContaining({ op: "add" }), reason: "low_confidence" },
    ]);
    expect(second?.state.gated.auto).toEqual([]);
    expect(second?.state.gated.needsHuman).toEqual([
      { operation: expect.objectContaining({ op: "reinforce" }), reason: "pending_neighbour" },
    ]);
    expect(ports.commit.operations).toEqual([]);
  });

  it("shows the second session that its neighbour is still pending", async () => {
    const { ports, checkpointer, graph } = twoSessions();

    await runSessions(graph, checkpointer, ports, [SESSION_ONE, SESSION_TWO]);

    const [first, second] = ports.model.callsTo("classify");
    expect(first?.user).not.toContain('"pending"');
    expect(second?.user).toContain('"pending":"in_pr"');
    expect(second?.user).toContain(FIRST.claim);
  });

  // The control: the same two sessions with the reindex step removed are the
  // duplicate this feature exists to stop.
  it("would produce two adds without it", async () => {
    const { ports, checkpointer, graph } = twoSessions();

    const noReindex = { pendingIndex: { async indexPending() {}, async clear() {} } };
    await runSessions(graph, checkpointer, noReindex, [SESSION_ONE, SESSION_TWO]);

    expect(ports.commit.operations.map((operation) => operation.op)).toEqual(["add", "add"]);
  });
});
