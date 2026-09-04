// The live provider, driven against a stub SDK client. Nothing here touches
// the network: `structured()` is the seam, and what it sends and what it does
// with the reply are both observable from a fake `messages.stream`.
//
// Three properties are worth pinning here, and each of them was a defect:
// an unpriced model must be refused before a call is billed rather than
// after; a reply cut off at the token cap must say so whichever block the cut
// landed in; and the `cache_control` marker must only go out when the prefix
// is long enough for the serving model to actually cache it.

import { describe, expect, it } from "vitest";
import { AnthropicModelProvider, priceCall } from "../../../src/io/model/anthropic-provider.js";
import {
  MAX_RESOLVE_TOOL_ITERATIONS,
  MAX_TOKENS_EXTRACT,
  MODEL_CLASSIFY,
  MODEL_DEFAULT,
  MODEL_EXTRACT,
  MODEL_PRICES,
  PRICE_CACHE_READ_MULTIPLIER,
  PRICE_CACHE_WRITE_MULTIPLIER,
  TOKENS_PER_MTOK,
} from "../../../src/core/config/constants.js";
import type { NodeName } from "../../../src/core/model/types.js";

// The SDK's own types are off-limits outside src/io/model/
// (eslint-rules/no-anthropic-sdk-outside-io-model.js), so the two SDK-shaped
// arguments are taken from the functions under test instead of imported.
type SdkClient = ConstructorParameters<typeof AnthropicModelProvider>[0];
type SdkUsage = Parameters<typeof priceCall>[0];

/** The serving model's minimum, spelled the way the provider spells it. */

const MODELS: Record<NodeName, string> = {
  extract: MODEL_EXTRACT,
  critic: MODEL_DEFAULT,
  classify: MODEL_CLASSIFY,
  resolve: MODEL_DEFAULT,
};

/** `resolve` runs on MODEL_DEFAULT in MODELS above. */
const MODEL_PRICE_DEFAULT = MODEL_PRICES[MODEL_DEFAULT]!;

const NO_USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

type Reply = {
  content: unknown[];
  stop_reason: string;
  usage?: Record<string, number>;
};

/**
 * A client that records the request and returns a canned message. `stream()`
 * is what the provider calls, and only `.finalMessage()` is read off it.
 */
function stubClient(reply: Reply): { client: SdkClient; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  const client = {
    messages: {
      stream(request: Record<string, unknown>) {
        sent.push(request);
        return {
          finalMessage: () =>
            Promise.resolve({ ...reply, usage: reply.usage ?? NO_USAGE }),
        };
      },
    },
  } as unknown as SdkClient;
  return { client, sent };
}

function textReply(text: string, stopReason = "end_turn"): Reply {
  return { content: [{ type: "text", text }], stop_reason: stopReason };
}

const REQUEST = {
  node: "extract" as const,
  system: "system prompt",
  user: "user turn",
  schema: { type: "object" },
};

describe("AnthropicModelProvider — pricing is refused before the call, not after it", () => {
  it("rejects a model with no list price when the provider is constructed", () => {
    expect(() => new AnthropicModelProvider(stubClient(textReply("{}")).client, {
      ...MODELS,
      extract: "claude-sonnet-5-20260101",
    })).toThrow(/no list price/);
  });

  it("names every unpriced model, once each", () => {
    let message = "";
    try {
      new AnthropicModelProvider(stubClient(textReply("{}")).client, {
        extract: "made-up-a",
        critic: "made-up-a",
        classify: "made-up-b",
        resolve: MODEL_DEFAULT,
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('"made-up-a"');
    expect(message).toContain('"made-up-b"');
    expect(message.match(/made-up-a/g)).toHaveLength(1);
  });

  it("never reaches the API with an unpriced model", () => {
    const { client, sent } = stubClient(textReply("{}"));

    expect(() => new AnthropicModelProvider(client, { ...MODELS, critic: "unpriced" })).toThrow();
    expect(sent).toHaveLength(0);
  });
});

describe("priceCall", () => {
  it("bills cache reads and cache writes at their own multipliers", () => {
    const price = { input: 5, output: 25 };
    const cost = priceCall(
      {
        input_tokens: 1000,
        output_tokens: 100,
        cache_read_input_tokens: 2000,
        cache_creation_input_tokens: 400,
      } as unknown as SdkUsage,
      price,
    );

    const inputUnits = 1000 + 2000 * PRICE_CACHE_READ_MULTIPLIER + 400 * PRICE_CACHE_WRITE_MULTIPLIER;
    expect(cost).toBeCloseTo((inputUnits * price.input + 100 * price.output) / TOKENS_PER_MTOK, 12);
  });

  it("treats absent cache counters as zero rather than NaN", () => {
    const cost = priceCall(
      { input_tokens: 1000, output_tokens: 0 } as unknown as SdkUsage,
      { input: 5, output: 25 },
    );

    expect(cost).toBeCloseTo((1000 * 5) / TOKENS_PER_MTOK, 12);
  });
});

describe("AnthropicModelProvider — a truncated reply names the token cap", () => {
  it("names the cap when the cut landed inside a thinking block, leaving no text at all", async () => {
    // Thinking is on by default and shares max_tokens, so this is what
    // exhausting the budget on a long transcript actually returns.
    const { client } = stubClient({
      content: [{ type: "thinking", thinking: "still reasoning when the budget ran out" }],
      stop_reason: "max_tokens",
    });

    await expect(new AnthropicModelProvider(client, MODELS).structured(REQUEST)).rejects.toThrow(
      `extract: reply hit max_tokens (${MAX_TOKENS_EXTRACT}) and was cut off`,
    );
  });

  it("names the cap when the cut landed mid-JSON", async () => {
    const { client } = stubClient(textReply('{"candidates": [{"claim": "half a c', "max_tokens"));

    await expect(new AnthropicModelProvider(client, MODELS).structured(REQUEST)).rejects.toThrow(
      `extract: reply hit max_tokens (${MAX_TOKENS_EXTRACT}) and was cut off`,
    );
  });

  it("still reports an empty reply as an empty reply when the cap was not the cause", async () => {
    const { client } = stubClient({ content: [], stop_reason: "end_turn" });

    await expect(new AnthropicModelProvider(client, MODELS).structured(REQUEST)).rejects.toThrow(
      "extract: model returned no text block (stop_reason=end_turn)",
    );
  });

  it("still reports malformed JSON as malformed JSON", async () => {
    const { client } = stubClient(textReply("not json at all"));

    await expect(new AnthropicModelProvider(client, MODELS).structured(REQUEST)).rejects.toThrow(
      "extract: structured output was not valid JSON: not json at all",
    );
  });
});

describe("AnthropicModelProvider — the cache marker always goes out", () => {
  function cacheControlOf(sent: Record<string, unknown>[]): unknown {
    const system = sent[0]?.system as Array<Record<string, unknown>>;
    return system[0]?.cache_control;
  }

  it("marks the system prefix regardless of how short it is", async () => {
    const { client, sent } = stubClient(textReply("{}"));

    await new AnthropicModelProvider(client, MODELS).structured({ ...REQUEST, system: "x" });

    // A prefix under the serving model's minimum is ignored by the API at no
    // cost. Withholding the marker instead forfeits every read it would have
    // earned, and no estimate available before the call is accurate enough to
    // make that trade safely — chars/4 put EXTRACT_SYSTEM at 772 tokens when
    // the API reported 1578.
    expect(cacheControlOf(sent)).toEqual({ type: "ephemeral" });
  });

  it("marks a long prefix the same way", async () => {
    const { client, sent } = stubClient(textReply("{}"));

    await new AnthropicModelProvider(client, MODELS).structured({ ...REQUEST, system: "x".repeat(40000) });

    expect(cacheControlOf(sent)).toEqual({ type: "ephemeral" });
  });
});

describe("AnthropicModelProvider — usage", () => {
  it("reports the model that served the call and its cost", async () => {
    const { client } = stubClient({
      ...textReply('{"ok": true}'),
      usage: {
        input_tokens: 1000,
        output_tokens: 100,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });

    const { value, usage } = await new AnthropicModelProvider(client, MODELS).structured(REQUEST);

    expect(value).toEqual({ ok: true });
    expect(usage.model).toBe(MODEL_EXTRACT);
    expect(usage.inputTokens).toBe(1000);
    expect(usage.costUsd).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The bounded tool loop (Phase 4.5)
// ---------------------------------------------------------------------------

/**
 * A client that returns a different canned message per turn, so a test can
 * script "ask for a file, then answer". The last reply repeats once the
 * script runs out, which is what makes an exhausted budget observable
 * separately from a script that was simply too short.
 */
function stubSequence(replies: Reply[]): { client: SdkClient; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  const client = {
    messages: {
      stream(request: Record<string, unknown>) {
        const reply = replies[Math.min(sent.length, replies.length - 1)]!;
        sent.push(request);
        return {
          finalMessage: () => Promise.resolve({ ...reply, usage: reply.usage ?? NO_USAGE }),
        };
      },
    },
  } as unknown as SdkClient;
  return { client, sent };
}

function toolUseReply(name: string, input: unknown, id = "tu_1"): Reply {
  return { content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use" };
}

const RESOLVE_REQUEST = {
  node: "resolve" as const,
  system: "resolve system",
  user: "two contradicting claims",
  schema: { type: "object" },
};

const TOOLS = [{ name: "read_file", description: "Read a file.", inputSchema: { type: "object" } }];

/** Records what the model asked for and answers every call the same way. */
function recordingRunner(content = "STAGING_WRITABLE = false") {
  const calls: Array<{ name: string; input: unknown }> = [];
  const runTool = async (name: string, input: unknown) => {
    calls.push({ name, input });
    return { content, isError: false };
  };
  return { calls, runTool };
}

describe("AnthropicModelProvider — the resolve tool loop", () => {
  it("does not loop at all when no tools were supplied", async () => {
    const { client, sent } = stubSequence([textReply('{"ok": true}')]);

    await new AnthropicModelProvider(client, MODELS).structured(REQUEST);

    expect(sent).toHaveLength(1);
    expect("tools" in sent[0]!).toBe(false);
    expect("tool_choice" in sent[0]!).toBe(false);
  });

  it("runs the tool the model asked for and feeds the result back", async () => {
    const { client, sent } = stubSequence([
      toolUseReply("read_file", { path: "src/config.ts" }),
      textReply('{"outcome": "new_wins"}'),
    ]);
    const { calls, runTool } = recordingRunner();

    const { value } = await new AnthropicModelProvider(client, MODELS).structured({
      ...RESOLVE_REQUEST,
      tools: TOOLS,
      runTool,
    });

    expect(calls).toEqual([{ name: "read_file", input: { path: "src/config.ts" } }]);
    expect(value).toEqual({ outcome: "new_wins" });
    expect(sent).toHaveLength(2);

    // The second request carries the assistant's tool_use turn and a user
    // turn holding the tool_result, paired by tool_use_id.
    const messages = sent[1]!.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(3);
    expect(messages[2]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_1",
          content: "STAGING_WRITABLE = false",
          is_error: false,
        },
      ],
    });
  });

  it("returns every result of a parallel turn in one user message", async () => {
    const { client, sent } = stubSequence([
      {
        content: [
          { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "a.ts" } },
          { type: "tool_use", id: "tu_2", name: "grep_repo", input: { pattern: "x" } },
        ],
        stop_reason: "tool_use",
      },
      textReply('{"outcome": "both_scoped"}'),
    ]);
    const { calls, runTool } = recordingRunner();

    await new AnthropicModelProvider(client, MODELS).structured({
      ...RESOLVE_REQUEST,
      tools: TOOLS,
      runTool,
    });

    expect(calls.map((call) => call.name)).toEqual(["read_file", "grep_repo"]);
    const messages = sent[1]!.messages as Array<{ role: string; content: unknown[] }>;
    // Splitting these across two user messages teaches the model to stop
    // asking for more than one tool at a time.
    expect(messages.at(-1)!.content).toHaveLength(2);
  });

  it("passes a tool failure through as an errored tool_result rather than throwing", async () => {
    const { client, sent } = stubSequence([
      toolUseReply("read_file", { path: "../../etc/passwd" }),
      textReply('{"outcome": "undecidable"}'),
    ]);

    const { value } = await new AnthropicModelProvider(client, MODELS).structured({
      ...RESOLVE_REQUEST,
      tools: TOOLS,
      runTool: async () => ({ content: "rejected: path escapes repoRoot", isError: true }),
    });

    const messages = sent[1]!.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(messages.at(-1)!.content[0]).toMatchObject({ is_error: true });
    // A refused path is a turn in the conversation, not a failed run.
    expect(value).toEqual({ outcome: "undecidable" });
  });

  it("stops at MAX_RESOLVE_TOOL_ITERATIONS and makes the model answer", async () => {
    // A model that would call a tool forever. The last turn forbids tool use,
    // so the budget running out produces an answer — in practice
    // `undecidable`, which 14-prompts.md tells the resolver to prefer when
    // the evidence does not settle the contradiction.
    const { client, sent } = stubSequence([
      toolUseReply("read_file", { path: "a.ts" }),
      toolUseReply("read_file", { path: "b.ts" }),
      toolUseReply("read_file", { path: "c.ts" }),
      toolUseReply("read_file", { path: "d.ts" }),
      toolUseReply("read_file", { path: "e.ts" }),
      textReply('{"outcome": "undecidable"}'),
    ]);
    const { calls, runTool } = recordingRunner();

    const { value } = await new AnthropicModelProvider(client, MODELS).structured({
      ...RESOLVE_REQUEST,
      tools: TOOLS,
      runTool,
    });

    expect(sent).toHaveLength(MAX_RESOLVE_TOOL_ITERATIONS);
    expect(calls).toHaveLength(MAX_RESOLVE_TOOL_ITERATIONS - 1);
    expect(value).toEqual({ outcome: "undecidable" });
  });

  it("offers the tools on every turn but forbids calling one on the last", async () => {
    const { client, sent } = stubSequence([toolUseReply("read_file", { path: "a.ts" })]);
    const { runTool } = recordingRunner();

    await new AnthropicModelProvider(client, MODELS).structured({
      ...RESOLVE_REQUEST,
      tools: TOOLS,
      runTool,
    }).catch(() => undefined);

    // Dropping `tools` on the last turn would invalidate the cached prefix,
    // which is rendered tools-first. tool_choice does the same job for free.
    for (const request of sent) {
      expect(request.tools).toEqual([
        { name: "read_file", description: "Read a file.", input_schema: { type: "object" } },
      ]);
    }
    expect(sent.slice(0, -1).map((request) => request.tool_choice)).toEqual(
      Array(sent.length - 1).fill({ type: "auto" }),
    );
    expect(sent.at(-1)!.tool_choice).toEqual({ type: "none" });
  });

  it("bills every turn of the loop, not just the last one", async () => {
    const turn = {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 0,
    };
    const { client } = stubSequence([
      { ...toolUseReply("read_file", { path: "a.ts" }), usage: turn },
      { ...textReply('{"outcome": "new_wins"}'), usage: turn },
    ]);
    const { runTool } = recordingRunner();

    const { usage } = await new AnthropicModelProvider(client, MODELS).structured({
      ...RESOLVE_REQUEST,
      tools: TOOLS,
      runTool,
    });

    expect(usage.inputTokens).toBe(200);
    expect(usage.outputTokens).toBe(20);
    expect(usage.cacheReadTokens).toBe(10);
    expect(usage.model).toBe(MODEL_DEFAULT);
    expect(usage.costUsd).toBeCloseTo(
      2 * priceCall(turn as unknown as SdkUsage, MODEL_PRICE_DEFAULT),
      12,
    );
  });

  it("refuses tools it has no way to run", async () => {
    const { client, sent } = stubSequence([textReply("{}")]);

    await expect(
      new AnthropicModelProvider(client, MODELS).structured({ ...RESOLVE_REQUEST, tools: TOOLS }),
    ).rejects.toThrow("resolve: tools were supplied with no runTool to execute them");
    expect(sent).toHaveLength(0);
  });
});
