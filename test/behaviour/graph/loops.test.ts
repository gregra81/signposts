// The two bounded loops, exercised through the compiled graph.
//
// Both are bounded at 2 attempts and both fail open: on exhaustion the
// offending candidate is dropped and the run continues. Neither can fail the
// run, and neither can spin — which is the property that stops an unbounded
// reflection loop burning a budget overnight.

import { describe, expect, it } from "vitest";
import { startRun } from "../../../src/graph/index.js";
import {
  CLAIM_MAX_CHARS,
  MAX_EXTRACT_ATTEMPTS,
  MAX_VALIDATE_ATTEMPTS,
} from "../../../src/core/config/constants.js";
import { EXTRACT_RETRY_PREAMBLE } from "../../../src/core/prompts/user-turns.js";
import { candidate, gutteredSession, makeGraph, RUN_INPUT, type Script } from "./harness.js";

function run(script: Script) {
  return makeGraph({ script, session: gutteredSession() });
}

const rejectAll = { verdicts: [{ tempId: "t1", keep: false, reason: "inferable from the code" }] };
const keepAll = { verdicts: [{ tempId: "t1", keep: true, reason: "specific and durable" }] };

describe("the reflection loop (critic -> extract)", () => {
  it("re-runs extraction when the critic rejects nearly everything", async () => {
    const { ports, checkpointer, graph } = run({
      extract: [{ candidates: [candidate()] }, { candidates: [candidate()] }],
      critic: [rejectAll, keepAll],
      classify: [{ tempId: "t1", kind: "NOVEL", rationale: "r" }],
    });

    await startRun(graph, checkpointer, RUN_INPUT);

    expect(ports.model.callsTo("extract")).toHaveLength(2);
    expect(ports.commit.operations).toHaveLength(1);
  });

  it("attaches the critique to the retry's user turn", async () => {
    const { ports, checkpointer, graph } = run({
      extract: [{ candidates: [candidate()] }, { candidates: [candidate()] }],
      critic: [rejectAll, keepAll],
      classify: [{ tempId: "t1", kind: "NOVEL", rationale: "r" }],
    });

    await startRun(graph, checkpointer, RUN_INPUT);

    const [first, second] = ports.model.callsTo("extract");
    expect(first?.user).not.toContain(EXTRACT_RETRY_PREAMBLE);
    expect(second?.user).toContain(EXTRACT_RETRY_PREAMBLE);
    expect(second?.user).toContain("inferable from the code");
  });

  // The bound. Without it, a critic that keeps rejecting loops forever.
  it("stops at MAX_EXTRACT_ATTEMPTS even when the critic never relents", async () => {
    const { ports, checkpointer, graph } = run({
      extract: [{ candidates: [candidate()] }],
      critic: [rejectAll],
    });

    const result = await startRun(graph, checkpointer, RUN_INPUT);

    expect(ports.model.callsTo("extract")).toHaveLength(MAX_EXTRACT_ATTEMPTS);
    expect(result.state.extractAttempts).toBe(MAX_EXTRACT_ATTEMPTS);
  });

  // Fails open: the run finishes, it just finishes with nothing.
  it("finishes the run with no operations rather than failing it", async () => {
    const { ports, checkpointer, graph } = run({
      extract: [{ candidates: [candidate()] }],
      critic: [rejectAll],
    });

    await startRun(graph, checkpointer, RUN_INPUT);

    expect(ports.commit.applied).toHaveLength(1);
    expect(ports.commit.operations).toEqual([]);
  });

  it("does not loop at all when the critic is satisfied first time", async () => {
    const { ports, checkpointer, graph } = run({
      extract: [{ candidates: [candidate()] }],
      critic: [keepAll],
      classify: [{ tempId: "t1", kind: "NOVEL", rationale: "r" }],
    });

    await startRun(graph, checkpointer, RUN_INPUT);

    expect(ports.model.callsTo("extract")).toHaveLength(1);
  });
});

describe("the self-correction loop (validate -> extract)", () => {
  const tooLong = candidate({ claim: "x".repeat(CLAIM_MAX_CHARS + 1) });

  // 04's acceptance criterion: exactly one regeneration, then dropped without
  // failing the run.
  it("regenerates once on a schema-invalid candidate, then drops it", async () => {
    const { ports, checkpointer, graph } = run({
      extract: [{ candidates: [tooLong] }, { candidates: [tooLong] }],
      critic: [keepAll],
      classify: [{ tempId: "t1", kind: "NOVEL", rationale: "r" }],
    });

    const result = await startRun(graph, checkpointer, RUN_INPUT);

    expect(ports.model.callsTo("extract")).toHaveLength(2);
    expect(result.state.validateAttempts).toBe(MAX_VALIDATE_ATTEMPTS);
    expect(ports.commit.applied).toHaveLength(1);
    expect(ports.commit.operations).toEqual([]);
  });

  it("reports what failed rather than swallowing it", async () => {
    const { checkpointer, graph } = run({
      extract: [{ candidates: [tooLong] }],
      critic: [keepAll],
      classify: [{ tempId: "t1", kind: "NOVEL", rationale: "r" }],
    });

    const result = await startRun(graph, checkpointer, RUN_INPUT);

    expect(result.state.validationErrors.length).toBeGreaterThan(0);
    expect(result.state.validationErrors[0]).toContain("t1");
  });

  // One bad candidate must never take a good one down with it.
  it("keeps the valid candidates when one is dropped", async () => {
    const good = candidate({ tempId: "t2", claim: "The ETL job runs at 03:00 UTC" });
    const script: Script = {
      extract: [{ candidates: [tooLong, good] }],
      critic: [
        {
          verdicts: [
            { tempId: "t1", keep: true, reason: "r" },
            { tempId: "t2", keep: true, reason: "r" },
          ],
        },
      ],
      classify: [
        { tempId: "t1", kind: "NOVEL", rationale: "r" },
        { tempId: "t2", kind: "NOVEL", rationale: "r" },
      ],
    };
    const { ports, checkpointer, graph } = run(script);

    await startRun(graph, checkpointer, RUN_INPUT);

    expect(ports.commit.operations).toHaveLength(1);
    expect(ports.commit.operations[0]).toHaveProperty("signpost.claim", "The ETL job runs at 03:00 UTC");
  });

  it("does not loop when everything validates", async () => {
    const { ports, checkpointer, graph } = run({
      extract: [{ candidates: [candidate()] }],
      critic: [keepAll],
      classify: [{ tempId: "t1", kind: "NOVEL", rationale: "r" }],
    });

    const result = await startRun(graph, checkpointer, RUN_INPUT);

    expect(ports.model.callsTo("extract")).toHaveLength(1);
    expect(result.state.validationErrors).toEqual([]);
  });
});
