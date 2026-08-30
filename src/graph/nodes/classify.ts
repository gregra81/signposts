// Node 5, `classify` — LLM, structured output. Highest call volume in the
// graph, smallest inputs.
//
// **This node exists because embeddings cannot do its job.** The neighbours
// were retrieved by similarity, so they are all *about* the same subject;
// only a language model can say whether they *agree*. Never collapse this
// into a similarity threshold.
//
// Routing happens from inside the node, via `Command`, rather than from a
// conditional edge. That is not a style choice: this node runs as one task
// per candidate, and a StateGraph's conditional edges read the shared
// channels, which do not yet carry this superstep's writes — so an edge here
// could not see the classification it is meant to route on. A `Command`
// carries the routing decision out of the same call that made it.
//
// The `goto` is a node name and not a `Send`. Also not a style choice: a
// pending `Send` is a task, not a channel write, and LangGraph finishes a
// deferred channel as soon as no *channel* write would trigger another step.
// Routing a contradiction with a `Send` therefore let the deferred `validate`
// run before `resolve_conflict` had answered — it saw the contradiction as
// unresolved and gated a candidate to a human that the resolver was about to
// settle. A named `goto` writes a real channel, and `validate` waits.

import { Command } from "@langchain/langgraph";
import { CLASSIFICATION_KINDS } from "../../core/contracts/graph.ts";
import { classifyUserTurn } from "../../core/prompts/user-turns.ts";
import { callStructured } from "../llm.ts";
import { NODE_IDS } from "../node-ids.ts";
import type { Candidate } from "../../core/contracts/graph.ts";
import type { GraphPorts } from "../ports.ts";
import type { Signpost } from "../../core/signpost/schema.ts";

export interface ClassifyPayload {
  repo: string;
  candidate: Candidate;
  neighbours: Signpost[];
}

export function makeClassifyNode(ports: GraphPorts) {
  return async function classifyNode(payload: ClassifyPayload): Promise<Command> {
    const classification = await callStructured({
      model: ports.model,
      node: "classify",
      user: classifyUserTurn(payload.candidate, payload.neighbours),
    });

    return new Command({
      update: { classifications: { [payload.candidate.tempId]: classification } },
      goto:
        classification.kind === CLASSIFICATION_KINDS.CONTRADICTION
          ? NODE_IDS.resolveConflict
          : NODE_IDS.validate,
    });
  };
}
