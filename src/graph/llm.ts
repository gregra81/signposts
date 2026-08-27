// The single way this graph talks to a model.
//
// Every LLM node calls through here, and every call is structured output:
// the JSON Schema goes out as `output_config.format`, and the reply is parsed
// with the zod schema that JSON Schema was derived from
// (src/core/graph/node-io.ts). There is no free-text parsing anywhere in the
// graph, and no second code path that could reintroduce it.
//
// The system turn comes from src/core/prompts/system.ts unmodified, which is
// what keeps the cache prefix byte-stable across every call in a run
// (08-models-and-credentials.md). Everything per-run is in the user turn.

import { jsonSchemaFor, NODE_RESPONSE_SCHEMAS } from "../core/graph/node-io.ts";
import { systemPromptFor } from "../core/prompts/system.ts";
import type { ModelProvider, NodeName, ToolDef } from "../core/model/types.ts";
import type { z } from "zod";

export interface StructuredCall {
  model: ModelProvider;
  node: NodeName;
  user: string;
  batchable?: boolean;
  /** Phase 4.5, `resolve` only. */
  tools?: ToolDef[];
}

/**
 * Calls `node` with its system prompt and schema, and returns the parsed,
 * validated reply.
 *
 * A reply that does not satisfy the schema throws. That is deliberate: with
 * structured output the provider is contracted to produce this shape, so a
 * violation is a provider or schema fault, not the kind of content problem
 * the reflection and self-correction loops exist to absorb. Retrying it in
 * the graph would spend the loop budget on the wrong failure.
 */
export async function callStructured<N extends NodeName>({
  model,
  node,
  user,
  batchable,
  tools,
}: StructuredCall & { node: N }): Promise<z.infer<(typeof NODE_RESPONSE_SCHEMAS)[N]>> {
  const { value } = await model.structured<unknown>({
    node,
    system: systemPromptFor(node),
    user,
    schema: jsonSchemaFor(node),
    ...(batchable === undefined ? {} : { batchable }),
    ...(tools === undefined ? {} : { tools }),
  });

  const schema = NODE_RESPONSE_SCHEMAS[node];
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `${node}: structured output did not satisfy its schema: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data as z.infer<(typeof NODE_RESPONSE_SCHEMAS)[N]>;
}
