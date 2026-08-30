// The graph, run end to end against a scripted model and hand-written ports.
// MemorySaver only — 04-extraction-graph.md permits it in tests and nowhere
// else.

import { describe, expect, it } from "vitest";
import { startRun } from "../../../src/graph/index.js";
import { MIN_GUTTERED_TOKENS } from "../../../src/core/config/constants.js";
import {
  candidate,
  gutteredSession,
  makeGraph,
  RUN_INPUT,
  type HarnessOptions,
  type Script,
} from "../helpers/graph-harness.js";

function run(script: Script, options: Partial<HarnessOptions> = {}) {
  return makeGraph({ script, session: gutteredSession(), ...options });
}

describe("the extraction graph, happy path", () => {
  it("turns one clear human correction into exactly one add", async () => {
    const { ports, checkpointer, graph } = run({
      extract: [{ candidates: [candidate()] }],
      critic: [{ verdicts: [{ tempId: "t1", keep: true, reason: "specific and durable" }] }],
      classify: [{ tempId: "t1", kind: "NOVEL", rationale: "nothing like it" }],
    });

    const result = await startRun(graph, checkpointer, RUN_INPUT);

    expect(result.disposition).toBe("fresh");
    expect(ports.commit.operations).toHaveLength(1);
    expect(ports.commit.operations[0]).toMatchObject({ op: "add" });
  });

  it("auto-publishes without entering human review when the gate says so", async () => {
    const { ports, checkpointer, graph } = run({
      extract: [{ candidates: [candidate()] }],
      critic: [{ verdicts: [{ tempId: "t1", keep: true, reason: "r" }] }],
      classify: [{ tempId: "t1", kind: "NOVEL", rationale: "r" }],
    });

    const result = await startRun(graph, checkpointer, RUN_INPUT);

    expect(result.state.gated.needsHuman).toEqual([]);
    expect(result.state.gated.auto).toHaveLength(1);
    expect(ports.commit.applied).toHaveLength(1);
  });

  // 04's acceptance criterion, verbatim: zero operations, at most two LLM calls.
  it("produces zero operations and at most two LLM calls when there is nothing to extract", async () => {
    const { ports, checkpointer, graph } = run({
      extract: [{ candidates: [] }],
      critic: [{ verdicts: [] }],
    });

    await startRun(graph, checkpointer, RUN_INPUT);

    expect(ports.commit.operations).toEqual([]);
    expect(ports.model.calls.length).toBeLessThanOrEqual(2);
  });

  // Node 1's early exit. The largest possible cost sink is not entered at all.
  it("terminates before any model call when the transcript is too small", async () => {
    const { ports, checkpointer, graph } = run(
      { extract: [{ candidates: [] }] },
      { session: gutteredSession({ tokenEstimate: MIN_GUTTERED_TOKENS - 1 }) },
    );

    await startRun(graph, checkpointer, RUN_INPUT);

    expect(ports.model.calls).toEqual([]);
    expect(ports.commit.applied).toEqual([]);
  });

  it("runs when the transcript sits exactly on the minimum", async () => {
    const { ports, checkpointer, graph } = run(
      {
        extract: [{ candidates: [] }],
        critic: [{ verdicts: [] }],
      },
      { session: gutteredSession({ tokenEstimate: MIN_GUTTERED_TOKENS }) },
    );

    await startRun(graph, checkpointer, RUN_INPUT);

    expect(ports.model.callsTo("extract")).toHaveLength(1);
  });

  it("drops a candidate the critic rejected", async () => {
    const { ports, checkpointer, graph } = run({
      extract: [{ candidates: [candidate({ tempId: "t1" }), candidate({ tempId: "t2", claim: "We refactored auth" })] }],
      critic: [
        {
          verdicts: [
            { tempId: "t1", keep: true, reason: "durable" },
            { tempId: "t2", keep: false, reason: "session summary" },
          ],
        },
      ],
      classify: [{ tempId: "t1", kind: "NOVEL", rationale: "r" }],
    });

    await startRun(graph, checkpointer, RUN_INPUT);

    expect(ports.neighbours.calls).toEqual(["t1"]);
    expect(ports.commit.operations).toHaveLength(1);
  });

  // The guttered text is never checkpointed, so extract has to re-derive it.
  it("re-gutters the transcript rather than reading text out of state", async () => {
    const { ports, checkpointer, graph } = run({
      extract: [{ candidates: [] }],
      critic: [{ verdicts: [] }],
    });

    const result = await startRun(graph, checkpointer, RUN_INPUT);

    expect(ports.gutter.calls).toBe(2);
    expect(JSON.stringify(result.state)).not.toContain("staging is read only");
  });

  it("records the transcript path and content hash in state instead of the text", async () => {
    const { checkpointer, graph } = run({
      extract: [{ candidates: [] }],
      critic: [{ verdicts: [] }],
    });

    const result = await startRun(graph, checkpointer, RUN_INPUT);

    expect(result.state.transcriptPath).toBe(RUN_INPUT.transcriptPath);
    expect(result.state.contentHash).toBe(RUN_INPUT.contentHash);
    expect(result.state.gutterStats).toEqual({
      tokenEstimate: 500,
      humanTurns: 1,
      redactionCount: 0,
    });
  });

  // Every LLM node sends a JSON schema. There is no free-text path.
  it("sends a structured-output schema on every model call", async () => {
    const { ports, checkpointer, graph } = run({
      extract: [{ candidates: [candidate()] }],
      critic: [{ verdicts: [{ tempId: "t1", keep: true, reason: "r" }] }],
      classify: [{ tempId: "t1", kind: "NOVEL", rationale: "r" }],
    });

    await startRun(graph, checkpointer, RUN_INPUT);

    expect(ports.model.calls.length).toBeGreaterThan(0);
    for (const call of ports.model.calls) {
      expect(call.schema).toMatchObject({ type: "object" });
    }
  });

  it("keeps the system turn byte-identical across every call to a node", async () => {
    const { ports, checkpointer, graph } = run({
      extract: [
        { candidates: [candidate()] },
        { candidates: [candidate()] },
      ],
      critic: [
        { verdicts: [{ tempId: "t1", keep: false, reason: "no" }] },
        { verdicts: [{ tempId: "t1", keep: true, reason: "yes" }] },
      ],
      classify: [{ tempId: "t1", kind: "NOVEL", rationale: "r" }],
    });

    await startRun(graph, checkpointer, RUN_INPUT);

    const systems = new Set(ports.model.callsTo("extract").map((call) => call.system));
    expect(ports.model.callsTo("extract").length).toBeGreaterThan(1);
    expect(systems.size).toBe(1);
  });
});
