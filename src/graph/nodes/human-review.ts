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
//
// **The node halts until the review is complete, not once.** A reviewer who
// answers three of five and comes back tomorrow used to find the thread
// finished and the other two silently discarded: the node checked
// `isReviewComplete` only on the way in, then wrote whatever had arrived and
// fell through the unconditional edge to `commit`. The loop below is what
// makes a partial answer a pause rather than a decision. LangGraph replays the
// interrupts a node has already resolved, in order, so re-entering the loop on
// resume returns the earlier answers and halts again on the first one still
// outstanding.

import { interrupt } from "@langchain/langgraph";
import { z } from "zod";
import { isReviewComplete, operationKey, retargetedEdits } from "../../core/graph/decisions.ts";
import { humanDecisionSchema } from "../../core/contracts/graph.ts";
import { summariseIssues } from "../../core/errors/format-zod-error.ts";
import type { GatedOperations, HumanDecision } from "../../core/contracts/graph.ts";
import type { ExtractionState, ExtractionUpdate } from "../state.ts";

/** What a reviewer is shown when the run halts. */
export interface ReviewRequest {
  repo: string;
  sessionId: string;
  /**
   * Keyed by `operationKey` — the same keys the resume value must use. Only
   * the operations still outstanding: on a resumed review, the ones already
   * answered are not asked about again.
   */
  needsHuman: GatedOperations["needsHuman"];
}

/** What the resuming `Command` must carry: one decision per gated operation. */
export type ReviewResponse = Record<string, HumanDecision>;

/**
 * The resume payload, parsed rather than trusted.
 *
 * `interrupt<_, ReviewResponse>()` is a compile-time cast over a value that
 * crossed a process boundary — it comes from a CLI, an HTTP handler or a UI
 * days later, and nothing between there and here validates it. Without this
 * parse, an `edit` whose `edited` operation went missing in transit committed
 * the *original* operation, which is the opposite of what the reviewer asked
 * for, and `applyDecisions`' comment claimed a guarantee that nothing enforced.
 *
 * The schema cannot express the second half of the contract — that an edit
 * stays within the operation it replaces — because a decision on its own does
 * not know which operation it answers. `retargetedEdits` checks that against
 * the keys, below.
 */
export const reviewResponseSchema = z.record(z.string(), humanDecisionSchema);

export function humanReviewNode(state: ExtractionState): ExtractionUpdate {
  let decisions: ReviewResponse = { ...state.humanDecisions };

  while (!isReviewComplete(state.gated, decisions)) {
    const answered = interrupt<ReviewRequest, ReviewResponse>({
      repo: state.repo,
      sessionId: state.sessionId,
      needsHuman: outstanding(state.gated, decisions),
    });
    decisions = { ...decisions, ...parseResponse(answered) };
  }

  return { humanDecisions: decisions };
}

/** The gated operations no decision has arrived for yet. */
function outstanding(
  gated: GatedOperations,
  decisions: ReviewResponse,
): GatedOperations["needsHuman"] {
  return gated.needsHuman.filter(({ operation }) => decisions[operationKey(operation)] === undefined);
}

function parseResponse(value: unknown): ReviewResponse {
  const parsed = reviewResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `human_review: the resume value is not a valid set of decisions: ${summariseIssues(parsed.error.issues)}`,
    );
  }

  // An edit may change what the operation says, never what it acts on
  // (06-review-and-pr.md). A retargeted edit would reach `commit` without
  // passing `validate`, which ran long before the gate.
  const retargeted = retargetedEdits(parsed.data);
  if (retargeted.length > 0) {
    throw new Error(
      `human_review: an edit may change an operation but not what it targets; ` +
        `retargeted: ${retargeted.join(", ")}`,
    );
  }

  return parsed.data;
}
