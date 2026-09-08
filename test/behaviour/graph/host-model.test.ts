// A run answered by the session that started it.
//
// The graph never calls anything: each model call halts the run and comes
// back as a pending request, the answer arrives through `resumeRun`, and the
// run carries on to the next one. These tests drive that loop end to end
// against the real graph, because every part of it that can break — a request
// that does not say which node it is for, an answer landing on the wrong
// candidate, a malformed answer reaching the gate — only shows up when the
// halts are real.

import { MemorySaver } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import {
  buildExtractionGraph,
  hostModel,
  isModelRequest,
  MODEL_REQUEST_KIND,
  resumeRun,
  REVIEW_REQUEST_KIND,
  startRun,
  type ModelRequest,
  type PendingRequest,
  type Replies,
  type ReviewRequest,
  type RunResult,
} from "../../../src/graph/index.js";
import { operationKey } from "../../../src/core/graph/decisions.js";
import { systemPromptFor } from "../../../src/core/prompts/system.js";
import { jsonSchemaFor } from "../../../src/core/graph/node-io.js";
import {
  candidate,
  existingSignpost,
  gutteredSession,
  makeHarness,
  RUN_INPUT,
} from "../helpers/graph-harness.js";
import type { Signpost } from "../../../src/core/signpost/schema.js";

function hostRun(options: { existing?: Signpost[]; neighbours?: Record<string, Signpost[]> } = {}) {
  const ports = {
    ...makeHarness({
      script: {},
      session: gutteredSession(),
      ...(options.existing === undefined ? {} : { existing: options.existing }),
      ...(options.neighbours === undefined ? {} : { neighbours: options.neighbours }),
    }),
    model: hostModel,
  };
  const checkpointer = new MemorySaver();
  return { ports, checkpointer, graph: buildExtractionGraph({ ports, checkpointer }) };
}

const FIRST = candidate({ tempId: "t1" });
const SECOND = candidate({ tempId: "t2", claim: "The ETL window is 02:00 to 04:00 UTC" });

/** The one pending request, asserted to be a model call so tests read without guards. */
function onlyModelRequest(result: RunResult): PendingRequest & { request: ModelRequest } {
  expect(result.pending).toHaveLength(1);
  const [pending] = result.pending;
  if (pending === undefined || !isModelRequest(pending.request)) {
    throw new Error(`expected one model request, got ${JSON.stringify(result.pending)}`);
  }
  return { id: pending.id, request: pending.request };
}

/** Answers every pending request with `answer(node)`, and resumes. */
function answerAll(result: RunResult, answer: (request: ModelRequest) => unknown): Replies {
  const replies: Replies = {};
  for (const pending of result.pending) {
    if (isModelRequest(pending.request)) {
      replies[pending.id] = answer(pending.request);
    }
  }
  return replies;
}

function keepAll(candidates: readonly { tempId: string }[]) {
  return { verdicts: candidates.map((c) => ({ tempId: c.tempId, keep: true, reason: "durable" })) };
}

describe("a model call halts the run", () => {
  it("comes back as a pending request naming the node that asked", async () => {
    const { graph, checkpointer } = hostRun();

    const result = await startRun(graph, checkpointer, RUN_INPUT);

    const { request } = onlyModelRequest(result);
    expect(request.kind).toBe(MODEL_REQUEST_KIND);
    expect(request.node).toBe("extract");
  });

  it("carries everything needed to answer it: both turns and the reply's schema", async () => {
    const { graph, checkpointer } = hostRun();

    const result = await startRun(graph, checkpointer, RUN_INPUT);

    const { request } = onlyModelRequest(result);
    expect(request.system).toBe(systemPromptFor("extract"));
    expect(request.schema).toEqual(jsonSchemaFor("extract"));
    // The user turn is where everything about this run lives.
    expect(request.user).toContain(RUN_INPUT.repo);
  });

  it("halts on the next call once the first is answered", async () => {
    const { graph, checkpointer } = hostRun();
    const first = await startRun(graph, checkpointer, RUN_INPUT);

    const second = await resumeRun(graph, checkpointer, RUN_INPUT, {
      [onlyModelRequest(first).id]: { candidates: [FIRST] },
    });

    expect(onlyModelRequest(second).request.node).toBe("critic");
  });

  it("refuses a resume with no answers rather than replaying the halt", async () => {
    const { graph, checkpointer } = hostRun();
    await startRun(graph, checkpointer, RUN_INPUT);

    await expect(resumeRun(graph, checkpointer, RUN_INPUT, {})).rejects.toThrow(
      /no answers to resume with/,
    );
  });

  it("says what the thread is waiting on when the answer is keyed by something else", async () => {
    const { graph, checkpointer } = hostRun();
    const first = await startRun(graph, checkpointer, RUN_INPUT);
    const { id } = onlyModelRequest(first);

    await expect(
      resumeRun(graph, checkpointer, RUN_INPUT, { extract: { candidates: [] } }),
    ).rejects.toThrow(`is not waiting on extract — it is waiting on ${id}`);
  });

  it("lists every id it is waiting on, and every key it was given", async () => {
    // Both lists are read by whoever has to correct the call, so both have to
    // survive being more than one item long.
    const { graph, checkpointer } = hostRun();
    const extract = await startRun(graph, checkpointer, RUN_INPUT);
    const critic = await resumeRun(graph, checkpointer, RUN_INPUT, {
      [onlyModelRequest(extract).id]: { candidates: [FIRST, SECOND] },
    });
    const classify = await resumeRun(graph, checkpointer, RUN_INPUT, {
      [onlyModelRequest(critic).id]: keepAll([FIRST, SECOND]),
    });
    expect(classify.pending).toHaveLength(2);

    const waitingOn = classify.pending.map((pending) => pending.id);
    await expect(
      resumeRun(graph, checkpointer, RUN_INPUT, { t1: {}, t2: {} }),
    ).rejects.toThrow(`is not waiting on t1, t2 — it is waiting on ${waitingOn.join(", ")}`);
  });

  it("says so when the thread is waiting on nothing at all", async () => {
    const { graph, checkpointer } = hostRun();
    const extract = await startRun(graph, checkpointer, RUN_INPUT);
    const critic = await resumeRun(graph, checkpointer, RUN_INPUT, {
      [onlyModelRequest(extract).id]: { candidates: [FIRST] },
    });
    const classify = await resumeRun(graph, checkpointer, RUN_INPUT, {
      [onlyModelRequest(critic).id]: keepAll([FIRST]),
    });
    const done = await resumeRun(
      graph,
      checkpointer,
      RUN_INPUT,
      answerAll(classify, () => ({
        tempId: "t1",
        kind: "NOVEL",
        rationale: "nothing recorded is about this",
      })),
    );
    expect(done.pending).toEqual([]);

    await expect(
      resumeRun(graph, checkpointer, RUN_INPUT, { "946c846c6ce4ed3e935172b3434f1b95": {} }),
    ).rejects.toThrow(/is not waiting on 946c846c6ce4ed3e935172b3434f1b95 — it is waiting on nothing/);
  });

  it("rejects an answer that does not satisfy the schema it was given", async () => {
    const { graph, checkpointer } = hostRun();
    const first = await startRun(graph, checkpointer, RUN_INPUT);

    // A reply typed into a resume is the one place a wrong shape can enter
    // the graph, so it fails here rather than three nodes later.
    await expect(
      resumeRun(graph, checkpointer, RUN_INPUT, {
        [onlyModelRequest(first).id]: { candidates: [{ tempId: "t1" }] },
      }),
    ).rejects.toThrow(/extract: structured output did not satisfy its schema/);
  });
});

describe("a halt with no id to answer it under", () => {
  it("fails loudly rather than reading as a finished run", async () => {
    // LangGraph derives an interrupt's id from the checkpoint namespace, so
    // this should not happen — but dropping such a halt would report the run
    // as finished, and the caller would record the session as processed while
    // the thread sits at an interrupt nothing will ever return to.
    const checkpointer = new MemorySaver();
    const graph = {
      invoke: () =>
        Promise.resolve({
          __interrupt__: [{ value: { kind: MODEL_REQUEST_KIND, node: "extract" } }],
        }),
    } as unknown as Parameters<typeof startRun>[0];

    await expect(startRun(graph, checkpointer, RUN_INPUT)).rejects.toThrow(
      /halted on an interrupt with no id/,
    );
  });

  it("names the checkpoint rather than blaming the caller on the way back in", async () => {
    // The same halt read off the checkpoint, where the list is the allow-list
    // a resume's keys are checked against. Dropping it there would reject a
    // caller answering the halt it was told about with "it is waiting on
    // nothing" — an error about the caller, for a fault in the checkpoint.
    const { graph, checkpointer } = hostRun();
    const first = await startRun(graph, checkpointer, RUN_INPUT);

    // Only `getState` is reached: the key check runs before the resume does.
    const blind = {
      getState: () =>
        Promise.resolve({
          tasks: [{ interrupts: [{ value: { kind: MODEL_REQUEST_KIND, node: "extract" } }] }],
        }),
    } as unknown as Parameters<typeof resumeRun>[0];

    await expect(
      resumeRun(blind, checkpointer, RUN_INPUT, { [onlyModelRequest(first).id]: {} }),
    ).rejects.toThrow(/halted on an interrupt with no id/);
  });
});

describe("a fan-out halts on every task at once", () => {
  it("asks about each candidate separately and files each answer under its own id", async () => {
    const { graph, checkpointer } = hostRun();

    const extract = await startRun(graph, checkpointer, RUN_INPUT);
    const critic = await resumeRun(graph, checkpointer, RUN_INPUT, {
      [onlyModelRequest(extract).id]: { candidates: [FIRST, SECOND] },
    });
    const classify = await resumeRun(graph, checkpointer, RUN_INPUT, {
      [onlyModelRequest(critic).id]: keepAll([FIRST, SECOND]),
    });

    expect(classify.pending).toHaveLength(2);
    const nodes = classify.pending.map((pending) =>
      isModelRequest(pending.request) ? pending.request.node : "?",
    );
    expect(nodes).toEqual(["classify", "classify"]);

    // Each request carries one candidate, and the answer keyed to that
    // request is the classification that candidate ends up with. A bare
    // resume value would hand the same answer to both tasks.
    const done = await resumeRun(
      graph,
      checkpointer,
      RUN_INPUT,
      answerAll(classify, (request) => ({
        tempId: request.user.includes(FIRST.claim) ? "t1" : "t2",
        kind: "NOVEL",
        rationale: "nothing recorded is about this",
      })),
    );

    expect(Object.keys(done.state.classifications).sort()).toEqual(["t1", "t2"]);
    expect(done.state.classifications.t1?.tempId).toBe("t1");
    expect(done.state.classifications.t2?.tempId).toBe("t2");
  });
});

describe("a run with nothing left to ask", () => {
  it("finishes with no pending requests and its operations committed", async () => {
    const { ports, graph, checkpointer } = hostRun();

    const extract = await startRun(graph, checkpointer, RUN_INPUT);
    const critic = await resumeRun(graph, checkpointer, RUN_INPUT, {
      [onlyModelRequest(extract).id]: { candidates: [FIRST] },
    });
    const classify = await resumeRun(graph, checkpointer, RUN_INPUT, {
      [onlyModelRequest(critic).id]: keepAll([FIRST]),
    });
    const done = await resumeRun(
      graph,
      checkpointer,
      RUN_INPUT,
      answerAll(classify, () => ({
        tempId: "t1",
        kind: "NOVEL",
        rationale: "nothing recorded is about this",
      })),
    );

    expect(done.pending).toEqual([]);
    expect(ports.commit.operations.map((operation) => operation.op)).toEqual(["add"]);
  });
});

describe("the two things a run halts on", () => {
  it("are told apart by kind, so a review is never answered as a model call", async () => {
    // A `refine` is always gated to a person (ALWAYS_HUMAN_OPS), so this run
    // ends at `human_review` rather than at another model call.
    const existing = existingSignpost();
    const { graph, checkpointer } = hostRun({
      existing: [existing],
      neighbours: { t1: [existing] },
    });

    const extract = await startRun(graph, checkpointer, RUN_INPUT);
    const critic = await resumeRun(graph, checkpointer, RUN_INPUT, {
      [onlyModelRequest(extract).id]: { candidates: [FIRST] },
    });
    const classify = await resumeRun(graph, checkpointer, RUN_INPUT, {
      [onlyModelRequest(critic).id]: keepAll([FIRST]),
    });
    const review = await resumeRun(
      graph,
      checkpointer,
      RUN_INPUT,
      answerAll(classify, () => ({
        tempId: "t1",
        kind: "REFINEMENT",
        relatedId: existing.id,
        rationale: "sharper wording of the same rule",
      })),
    );

    expect(review.pending).toHaveLength(1);
    const [pending] = review.pending;
    expect(isModelRequest(pending!.request)).toBe(false);
    expect(pending!.request.kind).toBe(REVIEW_REQUEST_KIND);
  });

  it("are answered the same way: a review decision resumes by interrupt id too", async () => {
    const existing = existingSignpost();
    const { ports, graph, checkpointer } = hostRun({
      existing: [existing],
      neighbours: { t1: [existing] },
    });

    const extract = await startRun(graph, checkpointer, RUN_INPUT);
    const critic = await resumeRun(graph, checkpointer, RUN_INPUT, {
      [onlyModelRequest(extract).id]: { candidates: [FIRST] },
    });
    const classify = await resumeRun(graph, checkpointer, RUN_INPUT, {
      [onlyModelRequest(critic).id]: keepAll([FIRST]),
    });
    const review = await resumeRun(
      graph,
      checkpointer,
      RUN_INPUT,
      answerAll(classify, () => ({
        tempId: "t1",
        kind: "REFINEMENT",
        relatedId: existing.id,
        rationale: "sharper wording of the same rule",
      })),
    );

    const [pending] = review.pending;
    const request = pending!.request as ReviewRequest;
    const decisions = Object.fromEntries(
      request.needsHuman.map(({ operation }) => [
        operationKey(operation),
        { decision: "accept", decidedAt: "2026-08-27T09:00:00.000Z" },
      ]),
    );

    const done = await resumeRun(graph, checkpointer, RUN_INPUT, { [pending!.id]: decisions });

    expect(done.pending).toEqual([]);
    expect(ports.commit.operations.map((operation) => operation.op)).toEqual(["refine"]);
  });
});
