// The response contract for each of the graph's four LLM nodes: one zod
// schema per node, plus the JSON Schema derived from that same schema.
//
// This pairing is the point of the module. The schema the model is asked to
// generate against (`jsonSchema`, sent as `output_config.format`) and the
// schema its reply is validated with (`schema`) are the same definition, so
// they cannot drift. 04-extraction-graph.md requires structured output at
// every LLM node — "not free-text parsing" — and this is what makes that
// mechanical rather than a convention.
//
// Roots are objects, never bare arrays: `extract` and `critic` are naturally
// list-valued, so each wraps its list in a single named property. A bare
// array root is not accepted as a structured-output format by the provider
// contract in 12-wire-contracts.md, and an object root also leaves room to
// add a sibling field later without changing the response's shape class.

import { z } from "zod";
import type { JSONSchema, NodeName } from "../model/types.ts";
import {
  candidateSchema,
  classificationSchema,
  criticVerdictSchema,
  resolutionSchema,
} from "../contracts/graph.ts";

export const extractResponseSchema = z.object({ candidates: z.array(candidateSchema) });
export type ExtractResponse = z.infer<typeof extractResponseSchema>;

export const criticResponseSchema = z.object({ verdicts: z.array(criticVerdictSchema) });
export type CriticResponse = z.infer<typeof criticResponseSchema>;

// classify and resolve are called once per candidate (04-extraction-graph.md
// fans out with `Send`), so their responses are single objects, not lists.
export const classifyResponseSchema = classificationSchema;
export type ClassifyResponse = z.infer<typeof classifyResponseSchema>;

export const resolveResponseSchema = resolutionSchema;
export type ResolveResponse = z.infer<typeof resolveResponseSchema>;

/** The zod schema each node's reply is parsed with. */
export const NODE_RESPONSE_SCHEMAS = {
  extract: extractResponseSchema,
  critic: criticResponseSchema,
  classify: classifyResponseSchema,
  resolve: resolveResponseSchema,
} as const satisfies Record<NodeName, z.ZodType>;

/**
 * The JSON Schema sent as `output_config.format` for a node, derived from
 * that node's zod schema.
 *
 * Derived on call rather than cached in a module-level object: stryker.config
 * sets `ignoreStatic: true`, so a top-level precomputed table would have its
 * mutants excluded from scoring. The conversion is cheap and each node makes
 * one call per candidate at most.
 */
export function jsonSchemaFor(node: NodeName): JSONSchema {
  return z.toJSONSchema(NODE_RESPONSE_SCHEMAS[node]) as JSONSchema;
}
