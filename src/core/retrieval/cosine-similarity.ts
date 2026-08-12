// Pure cosine-similarity helper. Reused by anything that compares two
// embedding vectors — currently the semantic-quality behaviour test
// (test/behaviour/embed/embedding-semantics.test.ts) that proves the real
// embedder places related claims closer together than unrelated ones.

/** Cosine similarity of two equal-length vectors, in [-1, 1] for non-zero inputs. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: length mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
