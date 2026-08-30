// The two bounded loops, exercised through the compiled graph.
//
// Each has its own retry budget and each fails open: on exhaustion the
// offending candidate is dropped and the run continues. Neither can fail the
// run, and neither can spin — which is the property that stops an unbounded
// reflection loop burning a budget overnight.
//
// The budgets are independent. A run that spends both re-runs `extract` three
// times, and that is the bound: once, plus one retry from each loop.

import { describe, expect, it } from "vitest";
import { startRun } from "../../../src/graph/index.js";
import {
  CLAIM_MAX_CHARS,
  MAX_EXTRACT_ATTEMPTS,
  MAX_VALIDATE_ATTEMPTS,
} from "../../../src/core/config/constants.js";
import {
  EXTRACT_INVALID_PREAMBLE,
  EXTRACT_RETRY_PREAMBLE,
} from "../../../src/core/prompts/user-turns.js";
import { candidate, gutteredSession, makeGraph, RUN_INPUT, type Script } from "../helpers/graph-harness.js";

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

  // A truncated critic reply used to be indistinguishable from a clean one:
  // the ratio was taken over the answers, so one keep verdict for three
  // candidates scored 0, continued, and `survivors` dropped the two unanswered
  // ones with no retry and nothing logged.
  it("retries when the critic answered about only one of three candidates", async () => {
    const three = [
      candidate({ tempId: "t1" }),
      candidate({ tempId: "t2", claim: "The ETL job runs at 03:00 UTC" }),
      candidate({ tempId: "t3", claim: "Deploys are frozen on Fridays" }),
    ];
    const { ports, checkpointer, graph } = run({
      extract: [{ candidates: three }, { candidates: [candidate()] }],
      critic: [{ verdicts: [{ tempId: "t1", keep: true, reason: "durable" }] }, keepAll],
      classify: [{ tempId: "t1", kind: "NOVEL", rationale: "r" }],
    });

    await startRun(graph, checkpointer, RUN_INPUT);

    expect(ports.model.callsTo("extract")).toHaveLength(2);
  });

  it("does not retry when the critic answered about all of them and kept them", async () => {
    const two = [candidate({ tempId: "t1" }), candidate({ tempId: "t2", claim: "Deploys are frozen on Fridays" })];
    const { ports, checkpointer, graph } = run({
      extract: [{ candidates: two }],
      critic: [
        {
          verdicts: [
            { tempId: "t1", keep: true, reason: "durable" },
            { tempId: "t2", keep: true, reason: "durable" },
          ],
        },
      ],
      classify: [
        { tempId: "t1", kind: "NOVEL", rationale: "r" },
        { tempId: "t2", kind: "NOVEL", rationale: "r" },
      ],
    });

    await startRun(graph, checkpointer, RUN_INPUT);

    expect(ports.model.callsTo("extract")).toHaveLength(1);
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

  // The retry used to send back a byte-identical prompt: `validate` wrote the
  // errors to state and `extract` rendered only the critique, so the
  // regeneration had nothing to go on and burned a model call.
  it("attaches the validation errors to the retry's user turn", async () => {
    const { ports, checkpointer, graph } = run({
      extract: [{ candidates: [tooLong] }, { candidates: [candidate()] }],
      critic: [keepAll],
      classify: [{ tempId: "t1", kind: "NOVEL", rationale: "r" }],
    });

    await startRun(graph, checkpointer, RUN_INPUT);

    const [first, second] = ports.model.callsTo("extract");
    expect(first?.user).not.toContain(EXTRACT_INVALID_PREAMBLE);
    expect(second?.user).toContain(EXTRACT_INVALID_PREAMBLE);
    expect(second?.user).toContain("t1");
    expect(second?.user).not.toBe(first?.user);
  });

  it("does not send the same errors back a second time", async () => {
    const { ports, checkpointer, graph } = run({
      extract: [{ candidates: [tooLong] }, { candidates: [candidate()] }],
      critic: [keepAll],
      classify: [{ tempId: "t1", kind: "NOVEL", rationale: "r" }],
    });

    const result = await startRun(graph, checkpointer, RUN_INPUT);

    expect(result.state.validationErrors).toEqual([]);
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

describe("the two budgets are independent", () => {
  const tooLong = candidate({ claim: "x".repeat(CLAIM_MAX_CHARS + 1) });

  // Sharing `extractAttempts` meant a self-correction retry spent the critic's
  // budget: from the third `extract` on, the critic's verdict was ignored
  // however bad the batch.
  it("still lets the critic send a batch back after a validate retry", async () => {
    const { ports, checkpointer, graph } = run({
      extract: [
        { candidates: [tooLong] },
        { candidates: [candidate()] },
        { candidates: [candidate()] },
      ],
      critic: [keepAll, rejectAll, keepAll],
      classify: [{ tempId: "t1", kind: "NOVEL", rationale: "r" }],
    });

    const result = await startRun(graph, checkpointer, RUN_INPUT);

    expect(ports.model.callsTo("extract")).toHaveLength(3);
    expect(result.state.criticRetries).toBe(1);
    expect(result.state.validateAttempts).toBe(MAX_VALIDATE_ATTEMPTS);
  });

  // `extract` clears the errors it consumed. Without that, the third run —
  // reached through the critic, with no `validate` in between to overwrite
  // them — would send the same validation errors back a second time.
  it("does not re-send validation errors the model has already answered", async () => {
    const { ports, checkpointer, graph } = run({
      extract: [
        { candidates: [tooLong] },
        { candidates: [candidate()] },
        { candidates: [candidate()] },
      ],
      critic: [keepAll, rejectAll, keepAll],
      classify: [{ tempId: "t1", kind: "NOVEL", rationale: "r" }],
    });

    await startRun(graph, checkpointer, RUN_INPUT);

    const [, second, third] = ports.model.callsTo("extract");
    expect(second?.user).toContain(EXTRACT_INVALID_PREAMBLE);
    expect(third?.user).not.toContain(EXTRACT_INVALID_PREAMBLE);
    expect(third?.user).toContain(EXTRACT_RETRY_PREAMBLE);
  });

  // And the bound still holds: three runs is the ceiling, not a step towards
  // more.
  it("never runs extract more than three times, however badly both loops go", async () => {
    const { ports, checkpointer, graph } = run({
      extract: [{ candidates: [tooLong] }],
      critic: [rejectAll],
      classify: [{ tempId: "t1", kind: "NOVEL", rationale: "r" }],
    });

    const result = await startRun(graph, checkpointer, RUN_INPUT);

    expect(ports.model.callsTo("extract").length).toBeLessThanOrEqual(3);
    expect(result.state.criticRetries).toBeLessThanOrEqual(MAX_EXTRACT_ATTEMPTS - 1);
    expect(ports.commit.operations).toEqual([]);
  });
});
