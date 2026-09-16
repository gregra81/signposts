// Builds a syntactically-safe FTS5 MATCH query out of arbitrary claim text.
// FTS5's query parser treats punctuation (periods, colons, hyphens, quotes)
// as syntax, so passing a raw claim through as-is can throw a syntax error
// instead of searching it. Tokens (stripped of punctuation, same as the
// tokenizer does to indexed content) are quoted and ORed — recall-first,
// since this feeds RRF fusion rather than being the final judgment.
// `null` means the text has no tokens to search on.
//
// **Stopwords are dropped** (19-value-to-a-user.md items 7 and 9). Recall-first
// was right about the OR; it was wrong about which tokens deserve one. A
// question like "is it safe to apply schema changes to the pre-production
// environment" has four words that carry the subject and eight that every
// signpost in the corpus contains, so BM25 matched most of the corpus and
// ranked it on "is", "it", "to" and "the". Half the fusion was noise, and the
// near-miss that contradicted the right answer rode that noise above it.
//
// Dropping them is not a precision/recall trade here: a stopword adds no
// document to the OR that a content word did not already add, because every
// document contains it. It only reorders what BM25 hands the fusion.
//
// The list is deliberately short and closed — articles, copulas, pronouns,
// prepositions, conjunctions and the modal/auxiliary verbs. Nothing
// domain-specific goes in it. A word that is uninformative in *this* corpus
// but informative in another ("repo", "test") stays, because the corpus this
// runs against is whatever repo installed the tool.

/** Tokens FTS5 would match in nearly every document, so they only add noise. */
const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "about", "after", "all", "also", "am", "an", "and", "any", "are", "as", "at",
  "be", "because", "been", "before", "being", "but", "by",
  "can", "cannot", "could",
  "did", "do", "does", "doing", "done", "down", "during",
  "each", "even", "ever", "every",
  "for", "from",
  "had", "has", "have", "having", "he", "her", "here", "hers", "him", "his", "how", "however",
  "i", "if", "in", "into", "is", "it", "its",
  "just",
  "may", "me", "might", "more", "most", "must", "my",
  "never", "no", "nor", "not", "now",
  "of", "off", "on", "once", "one", "only", "or", "other", "our", "out", "over", "own",
  "per",
  "same", "shall", "she", "should", "so", "some", "still", "such",
  "than", "that", "the", "their", "them", "then", "there", "these", "they", "this", "those",
  "through", "to", "too",
  "under", "until", "up", "us", "use", "used", "using",
  "very",
  "was", "we", "were", "what", "when", "where", "which", "while", "who", "whom", "why",
  "will", "with", "would",
  "you", "your",
]);

export function ftsQuery(text: string): string | null {
  const tokens = text.match(/[\p{L}\p{N}_]+/gu);
  if (!tokens) {
    return null;
  }

  const content = tokens.filter((token) => !STOPWORDS.has(token.toLowerCase()));
  // A query made entirely of stopwords keeps them. It will match most of the
  // corpus and rank it on nothing, which is a bad ranking — but returning
  // `null` would drop the lexical half of the fusion entirely for text that
  // does have words in it, and the vector half still has to be fused with
  // something. This is rare enough in real claims to be worth the fallback
  // rather than a second decision.
  const searchable = content.length > 0 ? content : tokens;
  return searchable.map((token) => `"${token}"`).join(" OR ");
}
