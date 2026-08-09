// Pure text-truncation heuristics for the gutter's assistant-turn budgets
// (02-ingestion.md "The gutter" / "The adjacency rule"). No LLM, no NLP —
// sentence splitting is deliberately a regex heuristic, not grammar-aware.

/**
 * Splits `text` into sentences, each retaining its trailing punctuation and
 * whitespace so `sentences(text).join("") === text` always holds — head()
 * relies on that to return the untouched source when it fits the budget.
 */
function sentences(text: string): string[] {
  // Every alternative requires at least one character, so this can never
  // produce an empty match — no need to filter empties out afterwards.
  const matches = text.match(/[^.!?]*[.!?]+\s*|[^.!?]+$/g);
  return matches ?? [];
}

// `String.prototype.slice` cuts on UTF-16 code units, not code points. An
// astral character (e.g. an emoji) straddling a slice boundary leaves a
// lone surrogate behind — not valid Unicode, and something JSON/DB
// consumers downstream can reject or mangle. Shave the lone surrogate
// rather than restoring its pair, so truncated output never grows past
// its budget (would otherwise risk P2 — output never longer than input).

/** Drops a trailing unpaired high surrogate left by a head-side cut. */
function trimTrailingHighSurrogate(text: string): string {
  return /[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text;
}

/** Drops a leading unpaired low surrogate left by a tail-side cut. */
function trimLeadingLowSurrogate(text: string): string {
  return /^[\uDC00-\uDFFF]/.test(text) ? text.slice(1) : text;
}

/**
 * First `maxSentences` sentences of `text`, or `maxChars` chars, whichever
 * hits first (02-ingestion.md: "first ~2 sentences or ~400 chars"). Text
 * that fits within both limits passes through unmodified.
 */
export function head(text: string, maxSentences: number, maxChars: number): string {
  let result = "";
  for (const sentence of sentences(text).slice(0, maxSentences)) {
    if (result.length + sentence.length > maxChars) {
      return trimTrailingHighSurrogate((result + sentence).slice(0, maxChars));
    }
    result += sentence;
  }
  return result;
}

/**
 * Head-plus-tail budget for the assistant turn immediately preceding a
 * human turn (R3): `headChars` from the start plus `tailChars` from the
 * end. If `text` already fits within `headChars + tailChars`, it passes
 * through unmodified rather than duplicating the middle.
 */
export function headAndTail(text: string, headChars: number, tailChars: number): string {
  if (text.length <= headChars + tailChars) {
    return text;
  }
  return (
    trimTrailingHighSurrogate(text.slice(0, headChars)) +
    trimLeadingLowSurrogate(text.slice(-tailChars))
  );
}
