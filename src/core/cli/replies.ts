// Parsing what `signpost resume --replies` was given: one answer per pending
// id, as JSON.
//
// Strict about the envelope and deliberately silent about the answers
// themselves. Each answer is validated against the schema its own request
// carried, and that happens in the graph (src/graph/llm.ts), which is the
// only place that knows which schema belongs to which id.

const REPLIES_KEY = "replies";

/** Accepts `{"replies": {...}}` or the bare map, and rejects anything else. */
export function parseReplies(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `--replies is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`--replies must be a JSON object: {"${REPLIES_KEY}": {"<pending id>": <answer>}}`);
  }

  const replies = REPLIES_KEY in parsed ? parsed[REPLIES_KEY] : parsed;
  if (!isPlainObject(replies)) {
    throw new Error(`--replies.${REPLIES_KEY} must be an object keyed by pending id`);
  }
  if (Object.keys(replies).length === 0) {
    throw new Error("--replies carries no answers");
  }
  return replies;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
