// Adapts a zod-derived JSON Schema into what `output_config.format` accepts.
//
// Pure, so it lives in core: no filesystem, no network, no SDK. That it
// encodes a fact about one vendor's decoder is not a reason to push it into
// io — core already owns MODEL_PRICES, the model ids and AUTH_CHAIN, and the
// line between the two halves of this codebase is side effects, not
// vendor-neutrality.
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

import type { JSONSchema } from "./types.ts";

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

/**
 * Keys whose values are a map of *names* to schemas, not schemas themselves.
 *
 * The filter below cannot tell a JSON Schema keyword from a field name, so
 * descending into one of these as if it were a schema would delete a field
 * called `format`, `pattern` or `minLength` from `properties` while leaving
 * it in `required` — which the decoder rejects as an invalid schema, i.e. a
 * 400 on every call to that node, caused by a field rename that looks
 * unrelated. None of the four current node schemas has such a field; this is
 * here so the first one that does is not a mystery.
 */
const SCHEMA_MAP_KEYWORDS = new Set(["properties", "patternProperties", "$defs", "definitions"]);

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
      .map(([key, nested]) => [key, SCHEMA_MAP_KEYWORDS.has(key) ? stripSchemaMap(nested) : strip(nested)]),
  );
}

/** Strips the values of a name -> schema map, leaving the names alone. */
function stripSchemaMap(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return strip(value);
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([name, schema]) => [name, strip(schema)]),
  );
}

export function toOutputFormatSchema(schema: JSONSchema): JSONSchema {
  return strip(schema) as JSONSchema;
}
