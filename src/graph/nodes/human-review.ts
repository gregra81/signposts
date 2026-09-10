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

/** Discriminates a review from the other thing a run halts on. */
export const REVIEW_REQUEST_KIND = "human_review";

/**
 * One gated operation as it is asked about, carrying the key its answer must
 * arrive under.
 *
 * The key is on the entry rather than implied by it. 12-wire-contracts.md's
 * rule is that everything needed to answer is in the output that asked, and
 * an end-to-end run found this the one place it did not hold: the payload was
 * an array of `{operation, reason}`, the resume value is keyed by
 * `operationKey`, and an answerer with only the payload in front of them had
 * to know the key was `<op>:<id>` and derive it. Answering with the signpost
 * ids — the only identifiers actually present — was accepted and discarded,
 * and the node re-halted with the same operations outstanding, exit 0, no
 * warning. An agent driving the loop by SKILL.md looped there forever
 * (18-end-to-end-gaps.md, item 3).
 */
export type GatedReviewItem = GatedOperations["needsHuman"][number] & {
  /** What the resume value files this operation's decision under. */
  key: string;
};

/** What a reviewer is shown when the run halts. */
export interface ReviewRequest {
  kind: typeof REVIEW_REQUEST_KIND;
  repo: string;
  sessionId: string;
  /**
   * Only the operations still outstanding: on a resumed review, the ones
   * already answered are not asked about again.
   */
  needsHuman: GatedReviewItem[];
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
      kind: REVIEW_REQUEST_KIND,
      repo: state.repo,
      sessionId: state.sessionId,
      needsHuman: outstanding(state.gated, decisions),
    });
    decisions = { ...decisions, ...parseReviewResponse(answered, state.gated) };
  }

  return { humanDecisions: decisions };
}

/** The gated operations no decision has arrived for yet, each with its key. */
function outstanding(gated: GatedOperations, decisions: ReviewResponse): GatedReviewItem[] {
  return gated.needsHuman
    .map(({ operation, reason }) => ({ key: operationKey(operation), operation, reason }))
    .filter((item) => decisions[item.key] === undefined);
}

/**
 * Exported for the same reason `reviewResponseSchema` is: everything below is
 * reached only through an `interrupt()`, which throws outside a running graph,
 * so a test that wants to assert what a bad resume value *says* cannot get at
 * it through the node. The messages are the product here — an answerer holding
 * only the halt output is the whole contract (12-wire-contracts.md).
 */
export function parseReviewResponse(value: unknown, gated: GatedOperations): ReviewResponse {
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

  // A key naming no gated operation is an error, not a no-op. It is the shape
  // a wrong answer actually takes — the ids were in the payload and the keys
  // were not — and swallowing it is what turned one wrong answer into an
  // endless loop (18-end-to-end-gaps.md, item 3).
  const known = new Set(gated.needsHuman.map(({ operation }) => operationKey(operation)));
  const unknown = Object.keys(parsed.data).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `human_review: no gated operation is keyed ${unknown.join(", ")}; ` +
        `answer under the \`key\` each needsHuman entry carries (expected one of: ${[...known].join(", ")})`,
    );
  }

  return parsed.data;
}
