// Node 4 keys the retrieved neighbours by tempId, and the fan-out edge turns
// that into one classify task per candidate.

import { describe, expect, it } from "vitest";
import { Send } from "@langchain/langgraph";
import {
  fanOutToClassify,
  makeRetrieveNeighboursNode,
} from "../../../../src/graph/nodes/retrieve-neighbours.js";
import { NODE_IDS } from "../../../../src/graph/node-ids.js";
import {
  candidate,
  existingSignpost,
  gutteredSession,
  makeHarness,
  graphState,
} from "../../../behaviour/graph/harness.js";

const T1 = candidate({ tempId: "t1" });
const T2 = candidate({ tempId: "t2" });
const NEIGHBOUR = existingSignpost({ id: "staging-writable" });

describe("the node", () => {
  it("keys each candidate's neighbours by its own tempId", async () => {
    const ports = makeHarness({
      script: {},
      session: gutteredSession(),
      neighbours: { t1: [NEIGHBOUR] },
    });

    const update = await makeRetrieveNeighboursNode(ports)(graphState({ candidates: [T1, T2] }));

    expect(update.neighbours).toEqual({ t1: [NEIGHBOUR], t2: [] });
  });

  it("queries once per candidate", async () => {
    const ports = makeHarness({ script: {}, session: gutteredSession() });

    await makeRetrieveNeighboursNode(ports)(graphState({ candidates: [T1, T2] }));

    expect(ports.neighbours.calls).toEqual(["t1", "t2"]);
  });

  it("writes an empty record when there were no candidates", async () => {
    const ports = makeHarness({ script: {}, session: gutteredSession() });

    const update = await makeRetrieveNeighboursNode(ports)(graphState({ candidates: [] }));

    expect(update.neighbours).toEqual({});
  });
});

describe("the fan-out edge", () => {
  it("sends one classify task per candidate, each carrying its own neighbours", () => {
    const sends = fanOutToClassify(
      graphState({ candidates: [T1, T2], neighbours: { t1: [NEIGHBOUR] } }),
    ) as Send[];

    expect(sends).toEqual([
      new Send(NODE_IDS.classify, { repo: "acme/api", candidate: T1, neighbours: [NEIGHBOUR] }),
      new Send(NODE_IDS.classify, { repo: "acme/api", candidate: T2, neighbours: [] }),
    ]);
  });

  it("skips classification entirely when nothing survived", () => {
    expect(fanOutToClassify(graphState({ candidates: [] }))).toBe(NODE_IDS.validate);
  });
});
