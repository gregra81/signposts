// Node 7b, `recheck_neighbours` — no LLM. Retrieval asked a second time,
// between `validate` and the gate.
//
// `retrieve_neighbours` answered before `classify` ran, and `classify` halts
// for a model call that the session driving the run may take minutes to
// answer. Another session can settle in that time and index its proposals.
// When those are what this candidate duplicates, `classify` never compared
// them and the pull request gets the same claim twice
// (src/core/graph/late-neighbours.ts has the incident and the rules).
//
// So the candidates that would `add` are retrieved again. Any that now come
// back with a pending neighbour they were not shown go back through
// `classify`, with the fresh list, and from there through `validate` again.
// The judgement stays with the model. This node only notices that the
// judgement was made on stale input.
//
// The loop ends because `neighbours` is rewritten with the fresh list before
// the second `classify`, so the next pass through here compares against what
// that `classify` was shown. It comes back only if yet another session
// settles in between, and a run has finitely many.
//
// Why here and not before `commit`: `existingIds` counts pending rows, and
// once a session halts at `human_review` its own `add`s are indexed. A second
// `validate` after that point would find this session's own slug taken and
// mint a `-2`. Before the gate, nothing of this session's is indexed yet.
//
// What is left uncovered is two sessions both passing this node before either
// has settled. That window is the few seconds between here and the end of the
// same invocation, not the minutes a model call takes.
//
// Routing is a `Command` for the reason `classify` gives: the decision and the
// update it depends on come out of one call.

import { Command, Send } from "@langchain/langgraph";
import { addingCandidates, lateNeighbourTargets } from "../../core/graph/late-neighbours.ts";
import { NODE_IDS } from "../node-ids.ts";
import type { ClassifyPayload } from "./classify.ts";
import type { ExtractionState } from "../state.ts";
import type { GraphPorts } from "../ports.ts";
import type { NeighbourSignpost } from "../../core/contracts/graph.ts";

export function makeRecheckNeighboursNode(ports: GraphPorts) {
  return async function recheckNeighboursNode(state: ExtractionState): Promise<Command> {
    const adding = new Set(addingCandidates(state.validated));
    const candidates = state.candidates.filter((candidate) => adding.has(candidate.tempId));

    const found = await Promise.all(
      candidates.map(async (candidate) => [candidate.tempId, await ports.neighbours.find(state.repo, candidate)] as const),
    );
    const fresh: Record<string, NeighbourSignpost[]> = Object.fromEntries(found);

    const late = new Set(lateNeighbourTargets({ seen: state.neighbours, fresh, sessionId: state.sessionId }));
    if (late.size === 0) {
      return new Command({ goto: NODE_IDS.confidenceGate });
    }

    const stale = candidates.filter((candidate) => late.has(candidate.tempId));
    return new Command({
      update: { neighbours: Object.fromEntries(stale.map((candidate) => [candidate.tempId, fresh[candidate.tempId]!])) },
      goto: stale.map((candidate) => {
        const payload: ClassifyPayload = {
          repo: state.repo,
          candidate,
          neighbours: fresh[candidate.tempId]!,
        };
        return new Send(NODE_IDS.classify, payload);
      }),
    });
  };
}
