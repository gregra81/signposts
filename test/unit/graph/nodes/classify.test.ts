// Node 5 routes from inside the node: a contradiction goes to the resolver,
// everything else straight to validate.

import { describe, expect, it } from "vitest";
import { makeClassifyNode } from "../../../../src/graph/nodes/classify.js";
import { NODE_IDS } from "../../../../src/graph/node-ids.js";
import { candidate, gutteredSession, makeHarness } from "../../../behaviour/helpers/graph-harness.js";

function classifyWith(reply: unknown) {
  const ports = makeHarness({ script: { classify: [reply] }, session: gutteredSession() });
  return makeClassifyNode(ports)({ repo: "acme/api", candidate: candidate(), neighbours: [] });
}

describe("routing", () => {
  it("sends a contradiction to resolve_conflict", async () => {
    const command = await classifyWith({
      tempId: "t1",
      kind: "CONTRADICTION",
      relatedId: "staging-writable",
      rationale: "The recorded claim says the opposite.",
    });

    expect(command.goto).toEqual([NODE_IDS.resolveConflict]);
  });

  it.each(["NOVEL", "DUPLICATE", "REFINEMENT"])("sends %s straight to validate", async (kind) => {
    const command = await classifyWith({
      tempId: "t1",
      kind,
      relatedId: kind === "NOVEL" ? undefined : "staging-writable",
      rationale: "No conflict.",
    });

    expect(command.goto).toEqual([NODE_IDS.validate]);
  });
});

describe("the update", () => {
  it("records the classification under the candidate's tempId", async () => {
    const classification = {
      tempId: "t1",
      kind: "NOVEL",
      rationale: "Nothing like it recorded.",
    };

    const command = await classifyWith(classification);

    expect(command.update).toEqual({ classifications: { t1: classification } });
  });
});
