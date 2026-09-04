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

describe("reindexing between the sessions of one run", () => {
  it("proposes one add and one reinforce, never two adds", async () => {
    const { ports, checkpointer, graph } = twoSessions();

    await runSessions(graph, checkpointer, ports, [SESSION_ONE, SESSION_TWO]);

    const operations = ports.commit.operations;
    expect(operations.map((operation) => operation.op)).toEqual(["add", "reinforce"]);

    const [added, reinforced] = operations;
    expect(reinforced).toMatchObject({
      op: "reinforce",
      id: added?.op === "add" ? added.signpost.id : "",
      sessionId: SESSION_TWO.sessionId,
    });
  });

  it("indexes the first session's proposal before the second is processed", async () => {
    const { ports, checkpointer, graph } = twoSessions();

    await runSessions(graph, checkpointer, ports, [SESSION_ONE, SESSION_TWO]);

    // One call, not two: the second session proposed a `reinforce`, which
    // adds no signpost to index — it appends provenance to the row the first
    // session already put there.
    expect(ports.pendingIndex.indexed).toHaveLength(1);
    expect(ports.pendingIndex.indexed[0]).toMatchObject({ repo: SESSION_ONE.repo });
    expect(ports.pendingIndex.indexed[0]?.signposts.map((signpost) => signpost.claim)).toEqual([
      FIRST.claim,
    ]);
  });

  it("shows the second session that its neighbour is still pending", async () => {
    const { ports, checkpointer, graph } = twoSessions();

    await runSessions(graph, checkpointer, ports, [SESSION_ONE, SESSION_TWO]);

    const [first, second] = ports.model.callsTo("classify");
    expect(first?.user).not.toContain('"pending":true');
    expect(second?.user).toContain('"pending":true');
    expect(second?.user).toContain(FIRST.claim);
  });

  // The control: the same two sessions with the reindex step removed are the
  // duplicate this feature exists to stop.
  it("would produce two adds without it", async () => {
    const { ports, checkpointer, graph } = twoSessions();

    await runSessions(graph, checkpointer, { pendingIndex: { async indexPending() {} } }, [
      SESSION_ONE,
      SESSION_TWO,
    ]);

    expect(ports.commit.operations.map((operation) => operation.op)).toEqual(["add", "add"]);
  });
});
