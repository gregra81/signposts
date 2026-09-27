// The ten node ids of 04-extraction-graph.md, in one place so a typo in an
// edge cannot silently create an eleventh node. There were eleven until
// `human_review` went (19-value-to-a-user.md, "Fewer human steps").
//
// The four LLM nodes' ids match NodeName (src/core/model/types.ts) where the
// names coincide, but they are not the same vocabulary: NodeName is what the
// provider dispatches a model and a prompt on, these are graph vertices.
// `resolve_conflict` is the node; `resolve` is its NodeName.

export const NODE_IDS = {
  gutter: "gutter",
  extract: "extract",
  critic: "critic",
  retrieveNeighbours: "retrieve_neighbours",
  classify: "classify",
  resolveConflict: "resolve_conflict",
  validate: "validate",
  recheckNeighbours: "recheck_neighbours",
  confidenceGate: "confidence_gate",
  commit: "commit",
} as const;

export type NodeId = (typeof NODE_IDS)[keyof typeof NODE_IDS];
