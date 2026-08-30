// Node 10 hands the applied operations to the port AND records them in state:
// `signpost resume` reports what a finished thread did by reading them back.

import { describe, expect, it } from "vitest";
import { makeCommitNode } from "../../../../src/graph/nodes/commit.js";
import { gutteredSession, makeHarness, graphState } from "../../../behaviour/graph/harness.js";
import type { Operation } from "../../../../src/core/contracts/graph.js";

const REINFORCE: Operation = {
  op: "reinforce",
  id: "staging-read-only",
  sessionId: "sess-1",
  author: "dev@acme.example",
};

describe("commit", () => {
  it("returns the operations it applied, not just an empty update", async () => {
    const ports = makeHarness({ script: {}, session: gutteredSession() });

    const update = await makeCommitNode(ports)(
      graphState({ gated: { auto: [REINFORCE], needsHuman: [] } }),
    );

    expect(update.operations).toEqual([REINFORCE]);
  });

  it("hands the same operations to the port, with the run's identifiers", async () => {
    const ports = makeHarness({ script: {}, session: gutteredSession() });

    await makeCommitNode(ports)(graphState({ gated: { auto: [REINFORCE], needsHuman: [] } }));

    expect(ports.commit.applied).toEqual([
      {
        repo: "acme/api",
        repoRoot: "/repo",
        sessionId: "sess-1",
        operations: [REINFORCE],
      },
    ]);
  });
});
