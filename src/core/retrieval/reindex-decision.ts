// Pure reindex-decision function (05-retrieval.md "Reindexing" /
// 13-constants.md REINDEX_TRIGGER: content-hash mismatch, missing index,
// or model change). No IO — the caller reads index_meta and passes in
// plain values.

export interface ReindexDecisionInput {
  indexExists: boolean;
  storedCorpusHash: string | null;
  currentCorpusHash: string;
  storedEmbeddingModel: string | null;
  currentEmbeddingModel: string;
}

export type ReindexDecision = "rebuild" | "skip";

export function decideReindex(input: ReindexDecisionInput): ReindexDecision {
  const rebuild =
    !input.indexExists ||
    input.storedCorpusHash !== input.currentCorpusHash ||
    input.storedEmbeddingModel !== input.currentEmbeddingModel;
  return rebuild ? "rebuild" : "skip";
}
