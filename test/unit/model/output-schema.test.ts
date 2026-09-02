// What `output_config.format` accepts is a subset of JSON Schema, and this
// adapter is what narrows z.toJSONSchema's output to it. Both directions
// matter: a keyword left in is a 400 on every call to that node, and a field
// wrongly stripped out of `properties` while `required` still names it is the
// same 400 from the other side.

import { describe, expect, it } from "vitest";
import { toOutputFormatSchema } from "../../../src/core/model/output-schema.js";

describe("toOutputFormatSchema — strips what the decoder rejects", () => {
  it("drops numeric bounds, string-length bounds, and the meta key", () => {
    const stripped = toOutputFormatSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        confidence: { type: "number", minimum: 0, maximum: 1, exclusiveMinimum: 0 },
        claim: { type: "string", minLength: 1, maxLength: 200, pattern: "^[a-z]" },
        tags: { type: "array", minItems: 1, maxItems: 5, uniqueItems: true },
      },
    });

    expect(stripped).toEqual({
      type: "object",
      properties: {
        confidence: { type: "number" },
        claim: { type: "string" },
        tags: { type: "array" },
      },
    });
  });

  it("strips at every depth, not just the top level", () => {
    const stripped = toOutputFormatSchema({
      type: "object",
      properties: {
        candidates: {
          type: "array",
          items: { type: "object", properties: { score: { type: "number", maximum: 1 } } },
        },
      },
    });

    const properties = stripped.properties as Record<string, { items: Record<string, unknown> } | undefined>;
    expect(properties.candidates?.items.properties).toEqual({ score: { type: "number" } });
  });
});

describe("toOutputFormatSchema — a property name is not a keyword", () => {
  // The landmine: the filter matches on key text, so a field *called*
  // `format` or `pattern` used to vanish from `properties` while surviving in
  // `required` — an invalid schema, and a 400 on every call to that node,
  // caused by a rename that looks unrelated to the model layer.
  const collidingNames = ["format", "pattern", "maximum", "minLength", "uniqueItems"];

  it.each(collidingNames)("keeps a field named %s", (name) => {
    const stripped = toOutputFormatSchema({
      type: "object",
      properties: { [name]: { type: "string", minLength: 1 } },
      required: [name],
    });

    expect(stripped.properties).toEqual({ [name]: { type: "string" } });
    expect(stripped.required).toEqual([name]);
  });

  it("keeps colliding names inside $defs too", () => {
    const stripped = toOutputFormatSchema({
      $defs: { pattern: { type: "object", properties: { format: { type: "string" } } } },
      type: "object",
    });

    const defs = stripped.$defs as { pattern: Record<string, unknown> };
    expect(defs.pattern.properties).toEqual({ format: { type: "string" } });
  });

  it("still strips a real keyword sitting beside a field of the same name", () => {
    const stripped = toOutputFormatSchema({
      type: "object",
      maximum: 10,
      properties: { maximum: { type: "number", maximum: 10 } },
    });

    expect(stripped).toEqual({ type: "object", properties: { maximum: { type: "number" } } });
  });
});

describe("toOutputFormatSchema — a malformed schema passes through, it does not throw", () => {
  // This adapter runs on the way to the API, so anything it throws on aborts
  // the call before it is made. Passing an odd shape through unchanged lets
  // the decoder reject it with a message about the schema, which is the more
  // useful failure of the two.

  it("keeps a null value rather than trying to walk it", () => {
    // `typeof null === "object"`, so without the null check this is where the
    // walk would throw instead of returning.
    expect(toOutputFormatSchema({ type: "string", example: null })).toEqual({
      type: "string",
      example: null,
    });
  });

  it("passes a null `properties` through", () => {
    expect(toOutputFormatSchema({ type: "object", properties: null })).toEqual({
      type: "object",
      properties: null,
    });
  });

  it("passes a string `properties` through as the string it is", () => {
    expect(toOutputFormatSchema({ type: "object", properties: "nonsense" })).toEqual({
      type: "object",
      properties: "nonsense",
    });
  });

  it("treats an array `properties` as an array, not as a name -> schema map", () => {
    expect(
      toOutputFormatSchema({ type: "object", properties: [{ type: "string", minLength: 1 }] }),
    ).toEqual({ type: "object", properties: [{ type: "string" }] });
  });
});
