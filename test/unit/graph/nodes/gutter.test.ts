// Node 1's one piece of arithmetic, and the promise that nothing else from the
// transcript leaves the node.

import { describe, expect, it } from "vitest";
import { countHumanTurns, makeGutterNode } from "../../../../src/graph/nodes/gutter.js";
import { gutteredSession, makeHarness, graphState } from "../../../behaviour/graph/harness.js";

describe("countHumanTurns", () => {
  it("counts only the human turns", () => {
    const session = gutteredSession({
      turns: [
        { role: "human", text: "a", at: "t1" },
        { role: "assistant", text: "b", at: "t2" },
        { role: "human", text: "c", at: "t3" },
      ],
    });

    expect(countHumanTurns(session)).toBe(2);
  });

  it("counts none when the assistant did all the talking", () => {
    const session = gutteredSession({
      turns: [
        { role: "assistant", text: "a", at: "t1" },
        { role: "assistant", text: "b", at: "t2" },
      ],
    });

    expect(countHumanTurns(session)).toBe(0);
  });
});

describe("the node", () => {
  it("writes the three stats and nothing else", async () => {
    const session = gutteredSession({
      tokenEstimate: 412,
      redactionCount: 3,
      turns: [{ role: "human", text: "only me", at: "t1" }],
    });
    const ports = makeHarness({ script: {}, session });

    const update = await makeGutterNode(ports)(graphState());

    expect(update).toEqual({
      gutterStats: { tokenEstimate: 412, humanTurns: 1, redactionCount: 3 },
    });
  });
});
