// Pure vector<->blob codec for the sqlite-vec mirror (signpost_vec stores
// claim_embedding as a raw Float32Array blob). No IO — just the encoding
// used by src/io/db/vector-index.ts.

/** Encodes a vector as the little-endian Float32Array blob sqlite-vec expects. */
export function vectorToBlob(vector: readonly number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}
