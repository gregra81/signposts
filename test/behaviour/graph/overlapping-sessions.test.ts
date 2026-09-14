// A session that settles while this one waits on `classify`.
//
// The skill drives `run` and `resume` one halt at a time, so a model call can
// sit unanswered for minutes. When another session finishes in that time, its
// proposals reach the pending index after this session retrieved and before it
// commits. Without `recheck_neighbours` both sessions `add` the same claim,
// which is what two parallel subagents did to gregra81/earnest.
//
// The other session is simulated by writing to the pending index from inside
// the first classify reply: that is the moment the real one would have landed.

import { describe, expect, it } from "vitest";
import { startRun } from "../../../src/graph/index.js";
import {
  candidate,
  existingSignpost,
  gutteredSession,
  makeGraph,
  RUN_INPUT,
  type Harness,
} from "../helpers/graph-harness.js";
import type { RecordedCall } from "../helpers/graph-harness.js";
import type { Signpost } from "../../../src/core/signpost/schema.js";

const OTHER_CLAIM = "You cannot write to staging except during the ETL window";

function proposedBy(sessionId: string): Signpost {
  return existingSignpost({
    id: "no-writes-to-staging-outside-etl",
    claim: OTHER_CLAIM,
    provenance: {
      session_ids: [sessionId],
      authors: ["dev@acme.example"],
      first_seen: "2026-08-27",
      last_reinforced: "2026-08-27",
    },
  });
}

/** Runs one candidate whose first classify lets `landing` into the pending index. */
async function runWhile(landing: Signpost | undefined) {
  let ports: Harness | undefined;
  const firstClassify = () => {
    if (landing !== undefined) {
      ports!.pendingIndex.indexed.push({
        repo: RUN_INPUT.repo,
        proposals: [{ signpost: landing, state: "in_pr" }],
      });
    }
    return { tempId: "t1", kind: "NOVEL", rationale: "nothing recorded is about this" };
  };
  const secondClassify = (call: RecordedCall) =>
    call.user.includes(OTHER_CLAIM)
      ? { tempId: "t1", kind: "DUPLICATE", relatedId: landing!.id, rationale: "the same lesson, reworded" }
      : { tempId: "t1", kind: "NOVEL", rationale: "still nothing" };

  const built = makeGraph({
    script: {
      extract: [{ candidates: [candidate()] }],
      critic: [{ verdicts: [{ tempId: "t1", keep: true, reason: "durable" }] }],
      classify: [firstClassify, secondClassify],
    },
    session: gutteredSession(),
  });
  ports = built.ports;
  const result = await startRun(built.graph, built.checkpointer, RUN_INPUT);
  return { ports: built.ports, result };
}

describe("a session that settles while this one is being classified", () => {
  it("classifies again against the new proposal, and reinforces it instead of adding a second", async () => {
    const { ports } = await runWhile(proposedBy("sess-other"));

    expect(ports.model.callsTo("classify")).toHaveLength(2);
    expect(ports.model.callsTo("classify")[1]!.user).toContain(OTHER_CLAIM);
    expect(ports.commit.operations).toEqual([
      expect.objectContaining({ op: "reinforce", id: "no-writes-to-staging-outside-etl" }),
    ]);
  });

  it("classifies once when nothing lands in the meantime", async () => {
    const { ports } = await runWhile(undefined);

    expect(ports.model.callsTo("classify")).toHaveLength(1);
    expect(ports.commit.operations).toEqual([expect.objectContaining({ op: "add" })]);
  });

  it("does not treat this session's own proposal as news", async () => {
    const { ports } = await runWhile(proposedBy(RUN_INPUT.sessionId));

    expect(ports.model.callsTo("classify")).toHaveLength(1);
  });
});
