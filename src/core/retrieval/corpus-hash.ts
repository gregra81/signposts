// Pure corpus-hash helper (05-retrieval.md "Reindexing" / 13-constants.md
// REINDEX_TRIGGER: "content-hash mismatch"). Order-independent of input
// array order — sorted inside, same pattern as paths.ts's hashRepoRoot.

import { createHash } from "node:crypto";

export interface CorpusEntry {
  id: string;
  content_hash: string;
}

/** sha256 hex over the sorted (by id) `${id}:${content_hash}` pairs, newline-joined. */
export function computeCorpusHash(signposts: readonly CorpusEntry[]): string {
  const sorted = [...signposts].sort((a, b) => a.id.localeCompare(b.id));
  const joined = sorted.map((s) => `${s.id}:${s.content_hash}`).join("\n");
  return createHash("sha256").update(joined).digest("hex");
}
