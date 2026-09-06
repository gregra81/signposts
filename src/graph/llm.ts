// The single way this graph talks to a model.
//
// Every LLM node calls through here, and every call is structured: the JSON
// Schema goes out with the request and the reply is parsed with the zod
// schema that JSON Schema was derived from (src/core/graph/node-io.ts).
// There is no free-text parsing anywhere in the graph, and no second code
// path that could reintroduce it.
//
// The system turn comes from src/core/prompts/system.ts unmodified: the
// instructions for a node are the same bytes on every call, and everything
// about this particular run is in the user turn.

import { jsonSchemaFor, NODE_RESPONSE_SCHEMAS } from "../core/graph/node-io.ts";
import { systemPromptFor } from "../core/prompts/system.ts";
import { summariseIssues } from "../core/errors/format-zod-error.ts";
import type { ModelProvider, NodeName } from "../core/model/types.ts";
import type { z } from "zod";

export interface StructuredCall {
  model: ModelProvider;
  node: NodeName;
  user: string;
}

/**
 * Calls `node` with its system prompt and schema, and returns the parsed,
 * validated reply.
 *
 * A reply that does not satisfy the schema throws. That is deliberate: the
 * schema went out with the request, so a violation is a fault in the answer
 * or in the schema, not the kind of content problem the reflection and
 * self-correction loops exist to absorb. Retrying it in the graph would spend
 * the loop budget on the wrong failure. It matters more here than it would
 * against an API that guarantees the shape: the reply is typed by hand into a
 * resume, and this is what stops a malformed one reaching the gate.
 */
export async function callStructured<N extends NodeName>({
  model,
  node,
  user,
}: StructuredCall & { node: N }): Promise<z.infer<(typeof NODE_RESPONSE_SCHEMAS)[N]>> {
  const value = await model.structured<unknown>({
    node,
    system: systemPromptFor(node),
    user,
    schema: jsonSchemaFor(node),
  });

  const schema = NODE_RESPONSE_SCHEMAS[node];
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `${node}: structured output did not satisfy its schema: ${summariseIssues(parsed.error.issues)}`,
    );
  }
  return parsed.data as z.infer<(typeof NODE_RESPONSE_SCHEMAS)[N]>;
}
