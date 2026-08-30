// The conditional fan-out: one task per candidate, each routed on its own
// classification. This is the third thing a linear pipeline cannot express —
// the path a candidate takes depends on what the model said about that
// candidate, not about the batch.

import { describe, expect, it } from "vitest";
import { startRun } from "../../../src/graph/index.js";
import {
  candidate,
  existingSignpost,
  gutteredSession,
  makeGraph,
  RUN_INPUT,
  type HarnessOptions,
  type Script,
} from "../helpers/graph-harness.js";

function run(script: Script, options: Partial<HarnessOptions> = {}) {
  return makeGraph({ script, session: gutteredSession(), ...options });
}

const THREE = [
  candidate({ tempId: "t1", claim: "Staging is read only outside the ETL window" }),
  candidate({ tempId: "t2", claim: "The ETL job runs at 03:00 UTC" }),
  candidate({ tempId: "t3", claim: "Auth tokens expire after five minutes" }),
];

const KEEP_THREE = {
  verdicts: THREE.map((c) => ({ tempId: c.tempId, keep: true, reason: "durable" })),
};

describe("the conditional fan-out", () => {
  it("retrieves neighbours once per surviving candidate", async () => {
    const { ports, checkpointer, graph } = run({
      extract: [{ candidates: THREE }],
      critic: [KEEP_THREE],
      classify: [
        { tempId: "t1", kind: "NOVEL", rationale: "r" },
        { tempId: "t2", kind: "NOVEL", rationale: "r" },
        { tempId: "t3", kind: "NOVEL", rationale: "r" },
      ],
    });

    await startRun(graph, checkpointer, RUN_INPUT);

    expect(ports.neighbours.calls.sort()).toEqual(["t1", "t2", "t3"]);
  });

  it("classifies each candidate in its own call", async () => {
    const { ports, checkpointer, graph } = run({
      extract: [{ candidates: THREE }],
      critic: [KEEP_THREE],
      classify: [
        { tempId: "t1", kind: "NOVEL", rationale: "r" },
        { tempId: "t2", kind: "NOVEL", rationale: "r" },
        { tempId: "t3", kind: "NOVEL", rationale: "r" },
      ],
    });

    await startRun(graph, checkpointer, RUN_INPUT);

    expect(ports.model.callsTo("classify")).toHaveLength(3);
  });

  // Each candidate takes a different path. Only the contradiction is
  // adjudicated; the others go straight on to validate.
  it("routes only the CONTRADICTION through resolve_conflict", async () => {
    const existing = existingSignpost();
    // A separate target for t3: two operations against one signpost is a
    // different failure (validate rejects it), and this test is about routing.
    const other = existingSignpost({ id: "etl-schedule", claim: "The ETL job runs nightly" });
    const { ports, checkpointer, graph } = run(
      {
        extract: [{ candidates: THREE }],
        critic: [KEEP_THREE],
        classify: [
          { tempId: "t1", kind: "CONTRADICTION", relatedId: existing.id, rationale: "opposite" },
          { tempId: "t2", kind: "NOVEL", rationale: "r" },
          { tempId: "t3", kind: "DUPLICATE", relatedId: other.id, rationale: "same" },
        ],
        resolve: [{ tempId: "t1", outcome: "new_wins", reasoning: "config changed in March" }],
      },
      { existing: [existing, other], neighbours: { t1: [existing], t3: [other] } },
    );

    await startRun(graph, checkpointer, RUN_INPUT);

    expect(ports.model.callsTo("resolve")).toHaveLength(1);
    expect(ports.model.callsTo("classify")).toHaveLength(3);
  });

  it("produces the operation each classification calls for", async () => {
    const existing = existingSignpost();
    const { ports, checkpointer, graph } = run(
      {
        extract: [{ candidates: THREE }],
        critic: [KEEP_THREE],
        classify: [
          { tempId: "t1", kind: "NOVEL", rationale: "r" },
          { tempId: "t2", kind: "DUPLICATE", relatedId: existing.id, rationale: "same" },
          { tempId: "t3", kind: "REFINEMENT", relatedId: "auth-token-expiry", rationale: "sharper" },
        ],
      },
      {
        existing: [existing, existingSignpost({ id: "auth-token-expiry", claim: "Tokens expire" })],
        neighbours: { t2: [existing] },
      },
    );

    const result = await startRun(graph, checkpointer, RUN_INPUT);

    const kinds = [...result.state.gated.auto, ...result.state.gated.needsHuman.map((e) => e.operation)]
      .map((operation) => operation.op)
      .sort();
    expect(kinds).toEqual(["add", "refine", "reinforce"]);
  });

  it("waits for every branch before validating", async () => {
    const existing = existingSignpost();
    const { checkpointer, graph } = run(
      {
        extract: [{ candidates: THREE }],
        critic: [KEEP_THREE],
        classify: [
          { tempId: "t1", kind: "CONTRADICTION", relatedId: existing.id, rationale: "opposite" },
          { tempId: "t2", kind: "NOVEL", rationale: "r" },
          { tempId: "t3", kind: "NOVEL", rationale: "r" },
        ],
        resolve: [{ tempId: "t1", outcome: "new_wins", reasoning: "changed" }],
      },
      { existing: [existing], neighbours: { t1: [existing] } },
    );

    const result = await startRun(graph, checkpointer, RUN_INPUT);

    // validate ran once, after the slow resolve_conflict branch — all three
    // candidates are accounted for, not just the two fast ones.
    expect(result.state.validateAttempts).toBe(1);
    expect(Object.keys(result.state.classifications).sort()).toEqual(["t1", "t2", "t3"]);
    expect(result.state.validated).toHaveLength(3);
  });

  // 04's acceptance criterion.
  it("never lets a contradicting candidate reach commit without a human", async () => {
    const existing = existingSignpost();
    const { ports, checkpointer, graph } = run(
      {
        extract: [{ candidates: [candidate({ confidence: 1 })] }],
        critic: [{ verdicts: [{ tempId: "t1", keep: true, reason: "r" }] }],
        classify: [{ tempId: "t1", kind: "CONTRADICTION", relatedId: existing.id, rationale: "opposite" }],
        resolve: [{ tempId: "t1", outcome: "undecidable", reasoning: "no evidence either way" }],
      },
      { existing: [existing], neighbours: { t1: [existing] } },
    );

    const result = await startRun(graph, checkpointer, RUN_INPUT);

    expect(result.state.gated.auto).toEqual([]);
    expect(result.state.gated.needsHuman[0]?.reason).toBe("unresolved_contradiction");
    // The run halted at human_review; nothing was committed.
    expect(ports.commit.applied).toEqual([]);
  });

  it("skips the fan-out entirely when nothing survived the critic", async () => {
    const { ports, checkpointer, graph } = run({
      extract: [{ candidates: THREE }],
      critic: [{ verdicts: THREE.map((c) => ({ tempId: c.tempId, keep: false, reason: "no" })) }],
    });

    await startRun(graph, checkpointer, RUN_INPUT);

    expect(ports.model.callsTo("classify")).toEqual([]);
    expect(ports.neighbours.calls).toEqual([]);
  });

  // Retrieval never pads to k; no neighbours is a real, correct case.
  it("classifies a candidate with no neighbours at all", async () => {
    const { ports, checkpointer, graph } = run({
      extract: [{ candidates: [candidate()] }],
      critic: [{ verdicts: [{ tempId: "t1", keep: true, reason: "r" }] }],
      classify: [{ tempId: "t1", kind: "NOVEL", rationale: "nothing like it" }],
    });

    await startRun(graph, checkpointer, RUN_INPUT);

    expect(ports.model.callsTo("classify")[0]?.user).toContain("Existing neighbours:\n[]");
  });
});
