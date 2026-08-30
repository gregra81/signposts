// Node 4, `retrieve_neighbours` — no LLM.
//
// One hybrid-search query per surviving candidate (05-retrieval.md), then the
// fan-out: a `Send` per candidate into `classify`. Retrieval does recall;
// classification does judgment, and the two are kept apart on purpose —
// "always use tabs" and "always use spaces" sit almost on top of each other
// in vector space, so no similarity threshold can stand in for the next node.
//
// Results are never padded to k. A candidate with no neighbours reaches
// `classify` with an empty list and is classified NOVEL, which is correct.

import { Send } from "@langchain/langgraph";
import { NODE_IDS } from "../node-ids.ts";
import type { ClassifyPayload } from "./classify.ts";
import type { ExtractionState, ExtractionUpdate } from "../state.ts";
import type { GraphPorts } from "../ports.ts";
import type { Signpost } from "../../core/signpost/schema.ts";

export function makeRetrieveNeighboursNode(ports: GraphPorts) {
  return async function retrieveNeighboursNode(state: ExtractionState): Promise<ExtractionUpdate> {
    const found = await Promise.all(
      state.candidates.map(async (candidate) => {
        const neighbours = await ports.neighbours.find(state.repo, candidate);
        return [candidate.tempId, neighbours] as const;
      }),
    );

    const neighbours: Record<string, Signpost[]> = {};
    for (const [tempId, list] of found) {
      neighbours[tempId] = list;
    }
    return { neighbours };
  };
}

/**
 * The fan-out edge: one `classify` task per candidate, each carrying only what
 * that candidate needs. Sent as payloads rather than read from state inside
 * `classify` so the tasks stay independent — nothing a classify task sees
 * depends on which sibling task ran first.
 *
 * No candidates means nothing to classify, so the run goes straight to
 * `validate`, which will find no operations and let the gate produce an empty
 * partition. That is the "no human correction produces zero operations" path.
 */
export function fanOutToClassify(state: ExtractionState): Send[] | typeof NODE_IDS.validate {
  if (state.candidates.length === 0) {
    return NODE_IDS.validate;
  }

  return state.candidates.map((candidate) => {
    const payload: ClassifyPayload = {
      repo: state.repo,
      candidate,
      neighbours: state.neighbours[candidate.tempId] ?? [],
    };
    return new Send(NODE_IDS.classify, payload);
  });
}
