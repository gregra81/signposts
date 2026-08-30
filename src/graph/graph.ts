// The topology of 04-extraction-graph.md, wired.
//
// Ten nodes, and four things a linear pipeline cannot express — which is the
// entire case for using a graph here rather than three chained LLM calls:
//
//   1. a reflection loop     critic -> extract, bounded at MAX_EXTRACT_ATTEMPTS
//   2. a self-correction loop validate -> extract, bounded at MAX_VALIDATE_ATTEMPTS
//   3. a conditional fan-out  one classify task per candidate, each routed on
//                             its own classification
//   4. a long-lived interrupt human_review may stay halted for days, in a
//                             process that has exited
//
// Both loops fail open: on exhaustion the offending candidate is dropped and
// the run continues. Neither can fail the run, and neither can spin.
//
// The checkpointer is a parameter, not a construction. 04-extraction-graph.md:
// "Build against the checkpointer *interface*, not the SQLite implementation."
// Swapping SQLite for Postgres is then a line at the composition root.

import { END, START, StateGraph } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { MIN_GUTTERED_TOKENS } from "../core/config/constants.ts";
import { validateRoute } from "../core/graph/routing.ts";
import { GraphAnnotation, type ExtractionState } from "./state.ts";
import { NODE_IDS } from "./node-ids.ts";
import { makeGutterNode } from "./nodes/gutter.ts";
import { makeExtractNode } from "./nodes/extract.ts";
import { makeCriticNode } from "./nodes/critic.ts";
import { fanOutToClassify, makeRetrieveNeighboursNode } from "./nodes/retrieve-neighbours.ts";
import { makeClassifyNode } from "./nodes/classify.ts";
import { makeResolveConflictNode } from "./nodes/resolve-conflict.ts";
import { makeValidateNode } from "./nodes/validate.ts";
import { makeConfidenceGateNode } from "./nodes/confidence-gate.ts";
import { humanReviewNode } from "./nodes/human-review.ts";
import { makeCommitNode } from "./nodes/commit.ts";
import type { GraphPorts } from "./ports.ts";

// ---------------------------------------------------------------------------
// Edge conditions — thin, and deliberately so. Each one reads a decision the
// nodes and src/core/graph/ already made; none of them makes a new one.
// ---------------------------------------------------------------------------

/** Node 1's early exit: a transcript too small to be worth a model call. */
export function afterGutter(state: ExtractionState): typeof NODE_IDS.extract | typeof END {
  return state.gutterStats.tokenEstimate >= MIN_GUTTERED_TOKENS ? NODE_IDS.extract : END;
}

/**
 * The reflection loop. `critic` writes a critique exactly when
 * `criticRoute` said to retry — the attempt bound is inside that function, so
 * an exhausted budget arrives here as an absent critique and falls through to
 * the survivors.
 */
export function afterCritic(
  state: ExtractionState,
): typeof NODE_IDS.extract | typeof NODE_IDS.retrieveNeighbours {
  return state.critique === undefined ? NODE_IDS.retrieveNeighbours : NODE_IDS.extract;
}

/**
 * The self-correction loop. "drop-invalid" and "continue" both go to the gate:
 * by then the offending candidates are already out of `validated`, and
 * carrying on with what survived is the whole point of bounding the loop.
 */
export function afterValidate(
  state: ExtractionState,
): typeof NODE_IDS.extract | typeof NODE_IDS.confidenceGate {
  const route = validateRoute({
    validationErrors: state.validationErrors,
    validateAttempts: state.validateAttempts,
  });
  return route === "retry-extract" ? NODE_IDS.extract : NODE_IDS.confidenceGate;
}

/** Node 9 is entered only if the gate actually produced something for a person. */
export function afterGate(
  state: ExtractionState,
): typeof NODE_IDS.humanReview | typeof NODE_IDS.commit {
  return state.gated.needsHuman.length > 0 ? NODE_IDS.humanReview : NODE_IDS.commit;
}

// ---------------------------------------------------------------------------
// Topology
// ---------------------------------------------------------------------------

export interface BuildGraphOptions {
  ports: GraphPorts;
  /**
   * Any BaseCheckpointSaver. SqliteSaver in production, MemorySaver in tests
   * only — without one, `human_review`'s interrupt has nowhere to halt.
   */
  checkpointer: BaseCheckpointSaver;
}

export function buildExtractionGraph({ ports, checkpointer }: BuildGraphOptions) {
  const builder = new StateGraph(GraphAnnotation)
    .addNode(NODE_IDS.gutter, makeGutterNode(ports))
    .addNode(NODE_IDS.extract, makeExtractNode(ports))
    .addNode(NODE_IDS.critic, makeCriticNode(ports))
    .addNode(NODE_IDS.retrieveNeighbours, makeRetrieveNeighboursNode(ports))
    // `ends` declares where the node's own Command may route. classify makes
    // its routing decision inside the node (see nodes/classify.ts), so the
    // compiler cannot infer these from edges.
    .addNode(NODE_IDS.classify, makeClassifyNode(ports), {
      ends: [NODE_IDS.resolveConflict, NODE_IDS.validate],
    })
    .addNode(NODE_IDS.resolveConflict, makeResolveConflictNode(ports))
    // Deferred: `validate` must run once, after every classify and
    // resolve_conflict task has finished. Without this it would fire as soon
    // as the first branch reached it and again after the slower
    // resolve_conflict branch — validating half a fan-out, twice.
    .addNode(NODE_IDS.validate, makeValidateNode(ports), { defer: true })
    .addNode(NODE_IDS.confidenceGate, makeConfidenceGateNode(ports))
    .addNode(NODE_IDS.humanReview, humanReviewNode)
    .addNode(NODE_IDS.commit, makeCommitNode(ports))

    .addEdge(START, NODE_IDS.gutter)
    .addConditionalEdges(NODE_IDS.gutter, afterGutter, [NODE_IDS.extract, END])
    .addEdge(NODE_IDS.extract, NODE_IDS.critic)
    .addConditionalEdges(NODE_IDS.critic, afterCritic, [
      NODE_IDS.extract,
      NODE_IDS.retrieveNeighbours,
    ])
    // The fan-out. One `classify` task per surviving candidate; no candidates
    // means nothing to classify, so it goes straight to `validate`.
    .addConditionalEdges(NODE_IDS.retrieveNeighbours, fanOutToClassify, [
      NODE_IDS.classify,
      NODE_IDS.validate,
    ])
    .addEdge(NODE_IDS.resolveConflict, NODE_IDS.validate)
    .addConditionalEdges(NODE_IDS.validate, afterValidate, [
      NODE_IDS.extract,
      NODE_IDS.confidenceGate,
    ])
    .addConditionalEdges(NODE_IDS.confidenceGate, afterGate, [
      NODE_IDS.humanReview,
      NODE_IDS.commit,
    ])
    .addEdge(NODE_IDS.humanReview, NODE_IDS.commit)
    .addEdge(NODE_IDS.commit, END);

  return builder.compile({ checkpointer });
}

export type ExtractionGraph = ReturnType<typeof buildExtractionGraph>;
