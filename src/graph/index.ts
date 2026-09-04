// Public surface of the extraction graph (Slice B of 16-build-plan.md).
//
// The composition root wires ports and a checkpointer, calls
// buildExtractionGraph once, then drives it with startRun / resumeRun.
// Nothing outside this module needs the node functions or the annotation.

export { buildExtractionGraph, type BuildGraphOptions, type ExtractionGraph } from "./graph.ts";
export {
  startRun,
  resumeRun,
  runSessions,
  threadConfigFor,
  initialState,
  type RunInput,
  type RunResult,
} from "./run.ts";
export { NODE_IDS, type NodeId } from "./node-ids.ts";
export { GraphAnnotation, type ExtractionState, type ExtractionUpdate } from "./state.ts";
export type { ReviewRequest, ReviewResponse } from "./nodes/human-review.ts";
export type {
  CommitInput,
  CommitPort,
  GraphPorts,
  GutterPort,
  NeighbourPort,
  PendingIndexPort,
  RepoToolsPort,
  SignpostIndexPort,
} from "./ports.ts";
