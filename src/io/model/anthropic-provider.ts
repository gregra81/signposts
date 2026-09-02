// The live ModelProvider: the only thing in signposts that calls a model, and
// the only thing that spends money.
//
// Every call is structured output: the JSON Schema goes out as
// `output_config.format`, so the reply is schema-valid JSON by contract and
// there is no free-text parsing anywhere. src/graph/llm.ts still validates it
// against the zod schema the JSON Schema came from — a provider that breaks
// its own contract should fail loudly here, not three nodes later.
//
// The system turn is byte-stable across every call in a run by construction
// (src/core/prompts/system.ts), which is the whole reason
// 08-models-and-credentials.md insists nothing per-run leaks into it.
//
// The marker always goes out. A prefix below the serving model's minimum is
// ignored silently — no error, `cache_creation_input_tokens: 0` — so sending
// one costs nothing, while withholding one costs every cache read it would
// have earned. There is no reliable way to know the tokenised length before
// the call, and guessing has already been wrong in the expensive direction:
// a chars/4 estimate put EXTRACT_SYSTEM at 772 tokens when the API reported
// the cached prefix as 1578, which would have suppressed caching on the
// highest-volume prefix in the graph.
//
// So `usage.cacheReadTokens > 0` is an acceptance criterion only for the nodes
// whose prompt is long enough to cache on the model serving them. Measured
// from the recorded fixtures: extract 1578 tokens on Sonnet 5, critic 848 and
// resolve 963 on Opus 5, all caching; classify never does, because its ~330
// tokens are far under Haiku 4.5's 4096 minimum.
//
// This knows nothing about fixtures. Recording is a concern of the eval
// harness, not of the product: the recorder lives in signposts-eval and wraps
// this provider, which is why there is no path to it here.

import Anthropic from "@anthropic-ai/sdk";
import {
  ERROR_EXCERPT_CHARS,
  MAX_TOKENS_EXTRACT,
  MAX_TOKENS_RESOLVE,
  MAX_TOKENS_SMALL,
  MODEL_PRICES,
  PRICE_CACHE_READ_MULTIPLIER,
  PRICE_CACHE_WRITE_MULTIPLIER,
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
import { toOutputFormatSchema } from "../../core/model/output-schema.ts";

/**
 * `extract` returns a whole candidate list and thinking shares the budget;
 * the other three return one small object each.
 */
const MAX_TOKENS: Record<NodeName, number> = {
  extract: MAX_TOKENS_EXTRACT,
  critic: MAX_TOKENS_SMALL,
  classify: MAX_TOKENS_SMALL,
  resolve: MAX_TOKENS_RESOLVE,
};

/** What one model costs per million tokens — an entry of MODEL_PRICES. */
type ModelPrice = { input: number; output: number };

/**
 * List price for what this call actually consumed, cache tiers included.
 *
 * Priced against the model that served the call, not a global default: each
 * node can run its own model, so `usage` alone does not say what it cost.
 *
 * Takes a resolved price rather than a model id, so it is total: an unpriced
 * model is rejected by modelPrices() when the provider is constructed, which
 * is before any request is sent. Looking the price up here instead meant a
 * call that succeeded and was billed could still throw on the way out and
 * take the paid-for reply with it — cost accounting is metadata, and metadata
 * must not be able to fail a call the API already charged for.
 */
export function priceCall(usage: Anthropic.Usage, price: ModelPrice): number {
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const inputUnits =
    usage.input_tokens +
    cacheRead * PRICE_CACHE_READ_MULTIPLIER +
    cacheWrite * PRICE_CACHE_WRITE_MULTIPLIER;
  return (
    (inputUnits * price.input + usage.output_tokens * price.output) / TOKENS_PER_MTOK
  );
}

/** `stop_reason` when the reply was cut off by the token cap rather than finished. */
const STOP_REASON_MAX_TOKENS = "max_tokens";

/** The response's JSON, from the single text block structured output returns. */
function parseReply(message: Anthropic.Message, node: NodeName): unknown {
  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === TEXT_BLOCK_TYPE)
    .map((block) => block.text)
    .join("");
  // Checked before the empty-text case, not after it. Thinking is on by
  // default and shares max_tokens, so a budget exhausted inside a thinking
  // block returns a message with no text block at all. Testing for empty text
  // first reported that as "no text block" and never named the cap — the same
  // misdirection that made the 8000 -> 16000 diagnosis take as long as it did.
  if (message.stop_reason === STOP_REASON_MAX_TOKENS) {
    throw new Error(
      `${node}: reply hit max_tokens (${MAX_TOKENS[node]}) and was cut off — raise the budget for this node`,
    );
  }
  if (text === "") {
    throw new Error(`${node}: model returned no text block (stop_reason=${message.stop_reason})`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${node}: structured output was not valid JSON: ${text.slice(0, ERROR_EXCERPT_CHARS)}`);
  }
}

/**
 * The price of every node's model, or a throw naming the ones with no entry.
 *
 * Called from the constructor so an unpriceable model is refused before the
 * first request rather than after it: `models` is a bare `z.string()` per node
 * in src/core/config/schema.ts, so a dated id, an alias or next quarter's
 * Sonnet passes config validation and reaches the API without this.
 */
function modelPrices(models: Record<NodeName, string>): Record<NodeName, ModelPrice> {
  const unpriced = Object.values(models).filter((model) => MODEL_PRICES[model] === undefined);
  if (unpriced.length > 0) {
    throw new Error(
      `no list price for model(s) ${[...new Set(unpriced)].map((model) => `"${model}"`).join(", ")} — add them to MODEL_PRICES`,
    );
  }
  return Object.fromEntries(
    Object.entries(models).map(([node, model]) => [node, MODEL_PRICES[model]]),
  ) as Record<NodeName, ModelPrice>;
}


export class AnthropicModelProvider implements ModelProvider {
  private readonly client: Anthropic;
  private readonly models: Record<NodeName, string>;
  private readonly prices: Record<NodeName, ModelPrice>;

  constructor(client: Anthropic, models: Record<NodeName, string>) {
    this.client = client;
    this.models = models;
    this.prices = modelPrices(models);
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
        system: [
          { type: TEXT_BLOCK_TYPE, text: req.system, cache_control: { type: "ephemeral" } },
        ],
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
      costUsd: priceCall(message.usage, this.prices[req.node]),
    };

    return { value: value as T, usage };
  }
}
