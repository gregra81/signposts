// Builds a syntactically-safe FTS5 MATCH query out of arbitrary claim text.
// FTS5's query parser treats punctuation (periods, colons, hyphens, quotes)
// as syntax, so passing a raw claim through as-is can throw a syntax error
// instead of searching it. Tokens (stripped of punctuation, same as the
// tokenizer does to indexed content) are quoted and ORed — recall-first,
// since this feeds RRF fusion rather than being the final judgment.
// `null` means the text has no tokens to search on.

export function ftsQuery(text: string): string | null {
  const tokens = text.match(/[\p{L}\p{N}_]+/gu);
  if (!tokens || tokens.length === 0) {
    return null;
  }
  return tokens.map((token) => `"${token}"`).join(" OR ");
}
