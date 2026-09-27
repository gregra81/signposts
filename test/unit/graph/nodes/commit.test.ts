// Node 10 hands the applied operations to the port AND records them in state:
// `signpost resume` reports what a finished thread did by reading them back.

import { describe, expect, it } from "vitest";
import { makeCommitNode } from "../../../../src/graph/nodes/commit.js";
import { gutteredSession, makeHarness, graphState } from "../../../behaviour/helpers/graph-harness.js";
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
        flagged: [],
      },
    ]);
  });

  // The gated half used to wait for an in-session review. It is committed now,
  // and handed over as `flagged` too, so the pull request can say why
  // (19-value-to-a-user.md, "Fewer human steps").
  it("commits what the gate held back as well, and flags it with the reason", async () => {
    const ports = makeHarness({ script: {}, session: gutteredSession() });
    const flagged = [{ operation: REINFORCE, reason: "bootstrap_run" as const }];

    const update = await makeCommitNode(ports)(graphState({ gated: { auto: [], needsHuman: flagged } }));

    expect(update.operations).toEqual([REINFORCE]);
    expect(ports.commit.applied[0]?.flagged).toEqual(flagged);
  });
});
