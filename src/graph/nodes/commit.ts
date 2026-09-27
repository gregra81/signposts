// Node 10, `commit` — deterministic. Write markdown, regenerate the index and
// commit it to the developer's signposts branch.
//
// All of that is git and filesystem work, so it lives behind CommitPort
// (../ports.ts) and this node is the join: it works out *what* to apply and
// hands it over.
//
// What it applies is both halves of the gate's partition. The gated half used
// to wait for a person inside the session, and was applied only if they
// accepted it; now it is committed and flagged in the pull request, which is
// where the person reviews it (19-value-to-a-user.md, "Fewer human steps").
// Nothing merges automatically either way (06-review-and-pr.md).

import type { ExtractionState, ExtractionUpdate } from "../state.ts";
import type { GraphPorts } from "../ports.ts";

export function makeCommitNode(ports: GraphPorts) {
  return async function commitNode(state: ExtractionState): Promise<ExtractionUpdate> {
    const flagged = state.gated.needsHuman;
    const operations = [...state.gated.auto, ...flagged.map(({ operation }) => operation)];

    await ports.commit.apply({
      repo: state.repo,
      repoRoot: state.repoRoot,
      sessionId: state.sessionId,
      operations,
      flagged,
    });

    // Recorded in state as well as applied: `signpost resume` reports what a
    // finished thread did, and reading it back beats re-deriving it.
    return { operations };
  };
}
