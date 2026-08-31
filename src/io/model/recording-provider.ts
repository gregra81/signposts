// The live ModelProvider, and the only thing in signposts that spends money.
//
// It wraps the real client, makes the call, and writes the reply to the
// fixture store on the way back — so one recording run turns the whole graph
// into something FixtureModelProvider can replay offline forever
// (09-evaluation.md, "Fixture replay").
//
// Every call is structured output: the JSON Schema goes out as
// `output_config.format`, so the reply is schema-valid JSON by contract and
// there is no free-text parsing anywhere. src/graph/llm.ts still validates
// it against the zod schema the JSON Schema came from — a provider that
// breaks its own contract should fail loudly here, not three nodes later.
//
// The system turn is sent as a cached block. It is byte-stable across every
// call in a run by construction (src/core/prompts/system.ts), which is the
// whole reason 08-models-and-credentials.md insists nothing per-run leaks
// into it. `usage.cacheReadTokens > 0` on the second and later calls of a
// run is the acceptance criterion that proves it, and it is recorded into
// every fixture rather than merely logged.

import Anthropic from "@anthropic-ai/sdk";
import {
  ERROR_EXCERPT_CHARS,
  MAX_TOKENS_EXTRACT,
  MAX_TOKENS_SMALL,
  PRICE_CACHE_READ_MULTIPLIER,
  PRICE_CACHE_WRITE_MULTIPLIER,
  PRICE_INPUT_PER_MTOK,
  PRICE_OUTPUT_PER_MTOK,
  TEXT_BLOCK_TYPE,
  TOKENS_PER_MTOK,
} from "../../core/config/constants.ts";
import type {
  JSONSchema,
  ModelProvider,
  NodeName,
  ToolDef,
  Usage,
} from "../../core/model/types.ts";
import { toOutputFormatSchema } from "./output-schema.ts";
import type { FixtureRecord } from "./fixture-store.ts";

/**
 * `extract` returns a whole candidate list and thinking shares the budget;
 * the other three return one small object each.
 */
const MAX_TOKENS: Record<NodeName, number> = {
  extract: MAX_TOKENS_EXTRACT,
  critic: MAX_TOKENS_SMALL,
  classify: MAX_TOKENS_SMALL,
  resolve: MAX_TOKENS_SMALL,
};

/** List price for what this call actually consumed, cache tiers included. */
export function priceCall(usage: Anthropic.Usage): number {
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const inputUnits =
    usage.input_tokens +
    cacheRead * PRICE_CACHE_READ_MULTIPLIER +
    cacheWrite * PRICE_CACHE_WRITE_MULTIPLIER;
  return (
    (inputUnits * PRICE_INPUT_PER_MTOK + usage.output_tokens * PRICE_OUTPUT_PER_MTOK) /
    TOKENS_PER_MTOK
  );
}

/** The response's JSON, from the single text block structured output returns. */
function parseReply(message: Anthropic.Message, node: NodeName): unknown {
  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === TEXT_BLOCK_TYPE)
    .map((block) => block.text)
    .join("");
  if (text === "") {
    throw new Error(`${node}: model returned no text block (stop_reason=${message.stop_reason})`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${node}: structured output was not valid JSON: ${text.slice(0, ERROR_EXCERPT_CHARS)}`);
  }
}

export class RecordingModelProvider implements ModelProvider {
  private readonly client: Anthropic;
  private readonly models: Record<NodeName, string>;
  private readonly writeFixture: (record: FixtureRecord) => void;

  constructor(
    client: Anthropic,
    models: Record<NodeName, string>,
    writeFixture: (record: FixtureRecord) => void,
  ) {
    this.client = client;
    this.models = models;
    this.writeFixture = writeFixture;
  }

  async structured<T>(req: {
    node: NodeName;
    system: string;
    user: string;
    schema: JSONSchema;
    batchable?: boolean;
    tools?: ToolDef[];
  }): Promise<{ value: T; usage: Usage }> {
    const model = this.models[req.node];

    // Streamed because MAX_TOKENS_EXTRACT plus adaptive thinking can outrun
    // the SDK's non-streaming HTTP timeout on a long transcript. The final
    // message is identical either way.
    const message = await this.client.messages
      .stream({
        model,
        max_tokens: MAX_TOKENS[req.node],
        system: [{ type: TEXT_BLOCK_TYPE, text: req.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: req.user }],
        output_config: { format: { type: "json_schema", schema: toOutputFormatSchema(req.schema) } },
        ...(req.tools === undefined
          ? {}
          : {
              tools: req.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
              })),
            }),
      })
      .finalMessage();

    const value = parseReply(message, req.node);
    const usage: Usage = {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: message.usage.cache_creation_input_tokens ?? 0,
      model,
      costUsd: priceCall(message.usage),
    };

    this.writeFixture({ node: req.node, model, system: req.system, user: req.user, value, usage });
    return { value: value as T, usage };
  }
}
