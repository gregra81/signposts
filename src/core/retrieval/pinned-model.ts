// Pure parsing of a pinned "<repo-id>@<revision>" model string
// (constants.EMBEDDING_MODEL in production). No IO — used by
// src/io/embed/embedder.ts to split the string before handing it to
// transformers.js's pipeline().

/** Splits a pinned "<repo-id>@<revision>" string on its last "@". */
export function splitPinnedModel(pinned: string): { repoId: string; revision: string } {
  const at = pinned.lastIndexOf("@");
  if (at <= 0) {
    throw new Error(`embeddingModel is not a pinned "<repo-id>@<revision>" string: ${JSON.stringify(pinned)}`);
  }
  return { repoId: pinned.slice(0, at), revision: pinned.slice(at + 1) };
}
