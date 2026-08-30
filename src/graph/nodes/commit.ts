// Node 10, `commit` — deterministic. Write markdown, regenerate the index,
// reindex embeddings, open or update the PR.
//
// All of that is git, filesystem and forge work, so it lives behind
// CommitPort (../ports.ts) and this node is the join: it works out *what* to
// apply and hands it over.
//
// What it applies is the gate's `auto` set plus the gated operations a person
// accepted or edited. An operation nobody answered is left out — silence is
// not consent, and nothing merges automatically (06-review-and-pr.md).

import { applyDecisions } from "../../core/graph/decisions.ts";
import type { ExtractionState, ExtractionUpdate } from "../state.ts";
import type { GraphPorts } from "../ports.ts";

export function makeCommitNode(ports: GraphPorts) {
  return async function commitNode(state: ExtractionState): Promise<ExtractionUpdate> {
    const operations = applyDecisions(state.gated, state.humanDecisions);

    await ports.commit.apply({
      repo: state.repo,
      repoRoot: state.repoRoot,
      sessionId: state.sessionId,
      operations,
    });

    // Recorded in state as well as applied: `signpost resume` reports what a
    // finished thread did, and reading it back beats re-deriving it.
    return { operations };
  };
}
