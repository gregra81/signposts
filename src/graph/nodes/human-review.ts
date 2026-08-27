// Node 9, `human_review` — `interrupt()`. The long-lived halt.
//
// Entered only when the gate produced something needing a person. It surfaces
// the operations and stops. **It may stay stopped for days**, in a process
// that has long since exited, and it resumes on the same thread id with the
// decisions folded into state. That is the reason the checkpointer is not
// optional, and the reason the thread id is computed from the repo, the
// session and the content hash rather than remembered
// (src/core/graph/thread-id.ts).
//
// `interrupt()` propagates by throwing a GraphInterrupt, so nothing here may
// wrap it in a try/catch. LangGraph re-executes this node from the top on
// resume, with `interrupt()` returning the value the resuming `Command`
// carried — which is why the partition it interrupted on has to be in state
// rather than recomputed from a confidence that is no longer around.

import { interrupt } from "@langchain/langgraph";
import { isReviewComplete } from "../../core/graph/decisions.ts";
import type { GatedOperations, HumanDecision } from "../../core/contracts/graph.ts";
import type { ExtractionState, ExtractionUpdate } from "../state.ts";

/** What a reviewer is shown when the run halts. */
export interface ReviewRequest {
  repo: string;
  sessionId: string;
  /** Keyed by `operationKey` — the same keys the resume value must use. */
  needsHuman: GatedOperations["needsHuman"];
}

/** What the resuming `Command` must carry: one decision per gated operation. */
export type ReviewResponse = Record<string, HumanDecision>;

export function humanReviewNode(state: ExtractionState): ExtractionUpdate {
  // Already answered — a resume that re-enters this node after the decisions
  // landed must not halt a second time.
  if (isReviewComplete(state.gated, state.humanDecisions)) {
    return {};
  }

  const request: ReviewRequest = {
    repo: state.repo,
    sessionId: state.sessionId,
    needsHuman: state.gated.needsHuman,
  };

  const decisions = interrupt<ReviewRequest, ReviewResponse>(request);
  return { humanDecisions: decisions };
}
