import { describe, expect, it } from "vitest";
import {
  jsonSchemaFor,
  NODE_RESPONSE_SCHEMAS,
} from "../../../src/core/graph/node-io.js";
import type { NodeName } from "../../../src/core/model/types.js";

const NODES: NodeName[] = ["extract", "critic", "classify", "resolve"];

describe("NODE_RESPONSE_SCHEMAS", () => {
  it("covers every NodeName", () => {
    expect(Object.keys(NODE_RESPONSE_SCHEMAS).sort()).toEqual([...NODES].sort());
  });

  it("parses a well-formed extract response", () => {
    const parsed = NODE_RESPONSE_SCHEMAS.extract.safeParse({
      candidates: [
        {
          tempId: "t1",
          claim: "Staging is read only",
          category: "environment",
          scope: { repo: "acme/api" },
          evidence: "Stated by the human.",
          confidence: 0.9,
          hedged: false,
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an extract response that is a bare array", () => {
    expect(NODE_RESPONSE_SCHEMAS.extract.safeParse([]).success).toBe(false);
  });

  it("rejects a critic verdict raising confidence above 1", () => {
    const parsed = NODE_RESPONSE_SCHEMAS.critic.safeParse({
      verdicts: [{ tempId: "t1", keep: true, reason: "r", adjustedConfidence: 1.5 }],
    });
    expect(parsed.success).toBe(false);
  });

  it("requires relatedId on a non-NOVEL classification", () => {
    const parsed = NODE_RESPONSE_SCHEMAS.classify.safeParse({
      tempId: "t1",
      kind: "DUPLICATE",
      rationale: "same claim",
    });
    expect(parsed.success).toBe(false);
  });

  it("allows a NOVEL classification with no relatedId", () => {
    const parsed = NODE_RESPONSE_SCHEMAS.classify.safeParse({
      tempId: "t1",
      kind: "NOVEL",
      rationale: "nothing like it",
    });
    expect(parsed.success).toBe(true);
  });

  it("requires both scopes on a both_scoped resolution", () => {
    const parsed = NODE_RESPONSE_SCHEMAS.resolve.safeParse({
      tempId: "t1",
      outcome: "both_scoped",
      reasoning: "different access paths",
      newScope: { repo: "acme/api" },
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts an undecidable resolution with no scopes", () => {
    const parsed = NODE_RESPONSE_SCHEMAS.resolve.safeParse({
      tempId: "t1",
      outcome: "undecidable",
      reasoning: "no evidence either way",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("jsonSchemaFor", () => {
  it.each(NODES)("produces an object-rooted schema for %s", (node) => {
    expect(jsonSchemaFor(node)).toMatchObject({ type: "object" });
  });

  // The pairing this module exists for: what the model is asked to generate
  // and what its reply is validated against are one definition.
  it("derives extract's schema from the same shape the parser expects", () => {
    const schema = jsonSchemaFor("extract") as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual(["candidates"]);
  });

  it("derives critic's schema from the same shape the parser expects", () => {
    const schema = jsonSchemaFor("critic") as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual(["verdicts"]);
  });

  it.each(NODES)("is byte-stable across calls for %s", (node) => {
    expect(JSON.stringify(jsonSchemaFor(node))).toBe(JSON.stringify(jsonSchemaFor(node)));
  });

  it("gives each node its own schema", () => {
    const rendered = NODES.map((node) => JSON.stringify(jsonSchemaFor(node)));
    expect(new Set(rendered).size).toBe(NODES.length);
  });
});
