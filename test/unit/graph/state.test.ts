// The state channels of src/graph/state.ts, exercised through a throwaway
// StateGraph rather than the annotation internals: the defaults and the
// reducers are only meaningful as what a node actually observes.

import { describe, expect, it } from "vitest";
import { END, START, StateGraph } from "@langchain/langgraph";
import { GraphAnnotation, type ExtractionState, type ExtractionUpdate } from "../../../src/graph/state.js";
import { STATE_VERSION } from "../../../src/core/config/constants.js";
import type { Signpost } from "../../../src/core/signpost/schema.js";

/**
 * Runs `updates` as one node each, in order, and returns the state a final
 * node observes. Reading it from inside the graph rather than from `invoke`'s
 * return value is deliberate: a channel nobody wrote is absent from the
 * output, and the defaults are exactly what this asserts on.
 */
async function drive(...updates: ExtractionUpdate[]) {
  let observed: ExtractionState | undefined;

  let builder = new StateGraph(GraphAnnotation);
  let previous: string = START;
  updates.forEach((update, index) => {
    const id = `step${index}`;
    builder = builder.addNode(id, () => update) as typeof builder;
    builder = builder.addEdge(previous as typeof START, id as never) as typeof builder;
    previous = id;
  });
  builder = builder.addNode("observe", (state: ExtractionState) => {
    observed = state;
    return {};
  }) as typeof builder;
  builder = builder.addEdge(previous as typeof START, "observe" as never) as typeof builder;
  builder = builder.addEdge("observe" as typeof START, END) as typeof builder;

  await builder.compile().invoke({});
  if (observed === undefined) {
    throw new Error("drive: the observe node never ran");
  }
  return observed;
}

const signpost = (id: string) => ({ id }) as unknown as Signpost;

describe("channel defaults", () => {
  it("starts the string channels empty, not with placeholder content", async () => {
    const state = await drive({});

    expect(state.sessionId).toBe("");
    expect(state.repo).toBe("");
    expect(state.repoRoot).toBe("");
    expect(state.contentHash).toBe("");
    expect(state.transcriptPath).toBe("");
  });

  it("starts version at STATE_VERSION and the collections empty", async () => {
    const state = await drive({});

    expect(state.version).toBe(STATE_VERSION);
    expect(state.candidates).toEqual([]);
    expect(state.operations).toEqual([]);
    expect(state.validated).toEqual([]);
    expect(state.validationErrors).toEqual([]);
    expect(state.gated).toEqual({ auto: [], needsHuman: [] });
    expect(state.gutterStats).toEqual({ tokenEstimate: 0, humanTurns: 0, redactionCount: 0 });
    expect(state.extractAttempts).toBe(0);
    expect(state.validateAttempts).toBe(0);
    expect(state.critique).toBeUndefined();
    expect(state.neighbours).toEqual({});
    expect(state.classifications).toEqual({});
    expect(state.resolutions).toEqual({});
    expect(state.humanDecisions).toEqual({});
  });
});

describe("mergeable channels", () => {
  it("merges partial writes instead of keeping only the last", async () => {
    const state = await drive(
      { neighbours: { t1: [signpost("a")] } },
      { neighbours: { t2: [signpost("b")] } },
    );

    expect(Object.keys(state.neighbours).sort()).toEqual(["t1", "t2"]);
  });

  it("resets to empty on a null write, so a regenerated tempId cannot inherit", async () => {
    const state = await drive(
      { neighbours: { t1: [signpost("a")] } },
      { neighbours: null },
      { neighbours: { t9: [] } },
    );

    expect(state.neighbours).toEqual({ t9: [] });
  });

  it("resets classifications and resolutions on null as well", async () => {
    const state = await drive(
      {
        classifications: { t1: { tempId: "t1", kind: "NOVEL", rationale: "New." } },
        resolutions: { t1: { tempId: "t1", outcome: "new_wins", reasoning: "Demonstrated." } },
      },
      { classifications: null, resolutions: null },
    );

    expect(state.classifications).toEqual({});
    expect(state.resolutions).toEqual({});
  });
});

describe("replaced channels", () => {
  it("keeps the last write rather than merging", async () => {
    const state = await drive({ validationErrors: ["first"] }, { validationErrors: ["second"] });

    expect(state.validationErrors).toEqual(["second"]);
  });
});
