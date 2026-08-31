// Adapts a zod-derived JSON Schema into what `output_config.format` accepts.
//
// The structured-outputs decoder supports a subset of JSON Schema: numeric
// bounds and string-length bounds are rejected outright (400
// invalid_request_error), and `$schema` is meta, not structure. z.toJSONSchema
// emits all of them, because the zod schemas are written as real validators.
//
// Stripping them here loses nothing. The constraint is still enforced — by
// src/graph/llm.ts, which parses every reply with the same zod schema the
// JSON Schema was derived from. The only difference is where a
// confidence of 1.4 gets caught: on the way back rather than by the decoder.
// Keeping the bounds in the zod schema and dropping them on the wire is what
// keeps those two facts in one place instead of two.

import type { JSONSchema } from "../../core/model/types.ts";

/** Keywords `output_config.format` rejects, plus the meta key it has no use for. */
const UNSUPPORTED_KEYWORDS = new Set([
  "$schema",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
]);

// `default` is not listed: none of the node schemas declares a zod default, so
// z.toJSONSchema never emits one.

function strip(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(strip);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !UNSUPPORTED_KEYWORDS.has(key))
      .map(([key, nested]) => [key, strip(nested)]),
  );
}

export function toOutputFormatSchema(schema: JSONSchema): JSONSchema {
  return strip(schema) as JSONSchema;
}
