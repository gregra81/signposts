// The graph's state channels (04-extraction-graph.md "State").
//
// One channel per field of 12-wire-contracts.md's GraphState, which
// src/core/contracts/graph.ts defines as a zod schema. This module is the
// LangGraph projection of that schema: the schema is what a checkpoint is
// validated against on load, these annotations are how nodes write to it.
//
// Two properties this file exists to get right:
//
// 1. **Plain objects, never `Map`.** A Map does not survive JSON
//    serialisation into a checkpoint — it resumes as `{}`, silently and
//    without error. Every keyed channel here is a Record.
//
// 2. **Merge reducers on the fan-out channels.** `retrieve_neighbours` and
//    `classify` run one task per candidate (`Send`), and several tasks write
//    the same channel in the same superstep. A last-value channel would keep
//    whichever landed last and drop the rest. `neighbours`,
//    `classifications` and `resolutions` therefore merge; writing `null`
//    resets one, which is what the reflection loop needs when `extract`
//    regenerates candidates under fresh tempIds and the old keys must not
//    linger.
//
// Guttered text has no channel here, deliberately. See gutter.ts.

import { Annotation } from "@langchain/langgraph";
import { STATE_VERSION } from "../core/config/constants.ts";
import type {
  Candidate,
  CandidateOperations,
  Classification,
  GatedOperations,
  HumanDecision,
  Operation,
  Resolution,
} from "../core/contracts/graph.ts";
import type { GutterStats } from "../core/contracts/graph.ts";
import type { Signpost } from "../core/signpost/schema.ts";

/**
 * A keyed channel that merges partial writes from parallel `Send` tasks, and
 * resets to empty when a node writes `null`.
 */
function mergeableRecord<V>() {
  return Annotation<Record<string, V>, Record<string, V> | null>({
    reducer: (left, right) => (right === null ? {} : { ...left, ...right }),
    default: () => ({}),
  });
}

/** Last write wins, with an initial value — the ordinary case. */
function replaced<V>(initial: () => V) {
  return Annotation<V>({ reducer: (_left, right) => right, default: initial });
}

export const GraphAnnotation = Annotation.Root({
  // Pinned, not merely defaulted: every checkpoint this build writes carries
  // STATE_VERSION, which is what makes an older one recognisable as foreign
  // on load. See src/core/graph/state-version.ts.
  version: replaced<typeof STATE_VERSION>(() => STATE_VERSION),

  sessionId: replaced<string>(() => ""),
  repo: replaced<string>(() => ""),
  repoRoot: replaced<string>(() => ""),
  contentHash: replaced<string>(() => ""),
  transcriptPath: replaced<string>(() => ""),

  gutterStats: replaced<GutterStats>(() => ({
    tokenEstimate: 0,
    humanTurns: 0,
    redactionCount: 0,
  })),

  candidates: replaced<Candidate[]>(() => []),
  critique: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),
  extractAttempts: replaced<number>(() => 0),
  criticRetries: replaced<number>(() => 0),

  neighbours: mergeableRecord<Signpost[]>(),
  classifications: mergeableRecord<Classification>(),
  resolutions: mergeableRecord<Resolution>(),

  validated: replaced<CandidateOperations[]>(() => []),
  operations: replaced<Operation[]>(() => []),
  gated: replaced<GatedOperations>(() => ({ auto: [], needsHuman: [] })),
  validationErrors: replaced<string[]>(() => []),
  validateAttempts: replaced<number>(() => 0),

  humanDecisions: mergeableRecord<HumanDecision>(),
});

export type ExtractionState = typeof GraphAnnotation.State;
export type ExtractionUpdate = typeof GraphAnnotation.Update;
