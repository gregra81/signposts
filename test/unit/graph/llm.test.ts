// callStructured — the one path from the graph to a model.
//
// Two things are asserted here that no behaviour test can reach: the optional
// request fields are omitted rather than sent as `undefined`, and the message
// a schema violation throws names the node and every offending path. That
// throw is a provider or schema fault, so it is the only signal anyone gets.

import { describe, expect, it } from "vitest";
import { callStructured } from "../../../src/graph/llm.js";
import { systemPromptFor } from "../../../src/core/prompts/system.js";
import { jsonSchemaFor } from "../../../src/core/graph/node-io.js";
import { MODEL_DEFAULT } from "../../../src/core/config/constants.js";
import type { ModelProvider, NodeName, Usage } from "../../../src/core/model/types.js";

const USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  model: MODEL_DEFAULT,
  costUsd: 0,
};

type Request = Parameters<ModelProvider["structured"]>[0];

/** Records the request it was given and replies with a fixed value. */
class RecordingProvider implements ModelProvider {
  readonly requests: Request[] = [];
  private readonly reply: unknown;

  constructor(reply: unknown) {
    this.reply = reply;
  }

  /** The only request, asserted to exist so the tests read without guards. */
  get sent(): Request {
    const [first] = this.requests;
    if (first === undefined) {
      throw new Error("RecordingProvider: the model was never called");
    }
    return first;
  }

  async structured<T>(req: Request): Promise<{ value: T; usage: Usage }> {
    this.requests.push(req);
    return { value: this.reply as T, usage: USAGE };
  }
}

const VALID_CLASSIFICATION = {
  tempId: "t1",
  kind: "NOVEL",
  rationale: "Nothing like it recorded.",
};

async function classifyWith(model: ModelProvider, extra: { batchable?: boolean } = {}) {
  return callStructured({ model, node: "classify", user: "u", ...extra });
}

describe("the request", () => {
  it("sends the node's own system prompt and JSON Schema", async () => {
    const model = new RecordingProvider(VALID_CLASSIFICATION);

    await classifyWith(model);

    expect(model.sent.system).toBe(systemPromptFor("classify"));
    expect(model.sent.schema).toEqual(jsonSchemaFor("classify"));
    expect(model.sent.user).toBe("u");
  });

  it("omits batchable and tools entirely when they were not given", async () => {
    const model = new RecordingProvider(VALID_CLASSIFICATION);

    await classifyWith(model);

    expect("batchable" in model.sent).toBe(false);
    expect("tools" in model.sent).toBe(false);
    expect("runTool" in model.sent).toBe(false);
  });

  it("forwards batchable when it was given, including false", async () => {
    const model = new RecordingProvider(VALID_CLASSIFICATION);

    await classifyWith(model, { batchable: false });

    expect("batchable" in model.sent).toBe(true);
    expect(model.sent.batchable).toBe(false);
  });

  it("forwards tools when they were given", async () => {
    const model = new RecordingProvider({
      tempId: "t1",
      outcome: "new_wins",
      reasoning: "The newer claim was demonstrated.",
    });
    const tools = [{ name: "read_file", description: "Read a file.", inputSchema: {} }];

    await callStructured({ model, node: "resolve" as NodeName, user: "u", tools });

    expect(model.sent.tools).toEqual(tools);
  });

  it("forwards the tool runner alongside the tools", async () => {
    // A ToolDef says what a tool is; only the runner can perform one. The
    // provider refuses a call carrying tools it cannot execute, so dropping
    // this on the way through would fail every resolve.
    const model = new RecordingProvider({
      tempId: "t1",
      outcome: "undecidable",
      reasoning: "The evidence did not settle it.",
    });
    const runTool = async () => ({ content: "", isError: false });

    await callStructured({ model, node: "resolve" as NodeName, user: "u", runTool });

    expect(model.sent.runTool).toBe(runTool);
  });

  it("returns the parsed reply", async () => {
    const model = new RecordingProvider(VALID_CLASSIFICATION);

    await expect(classifyWith(model)).resolves.toEqual(VALID_CLASSIFICATION);
  });
});

describe("a reply that does not satisfy the schema", () => {
  it("throws naming the node and the offending field", async () => {
    const model = new RecordingProvider({ tempId: "t1", kind: "NOVEL" });

    await expect(classifyWith(model)).rejects.toThrow(
      "classify: structured output did not satisfy its schema: rationale:",
    );
  });

  it("joins a nested path with dots", async () => {
    const model = new RecordingProvider({ candidates: [{ tempId: "t1" }] });

    await expect(callStructured({ model, node: "extract", user: "u" })).rejects.toThrow(
      /candidates\.0\.claim: /,
    );
  });

  it("labels a root-level violation (root) rather than leaving it blank", async () => {
    const model = new RecordingProvider("not an object at all");

    await expect(classifyWith(model)).rejects.toThrow(
      /structured output did not satisfy its schema: \(root\): /,
    );
  });

  it("separates several issues with a semicolon", async () => {
    const model = new RecordingProvider({ kind: "NOVEL" });

    const error = await classifyWith(model).then(
      () => undefined,
      (thrown: unknown) => thrown as Error,
    );

    expect(error?.message).toMatch(/tempId: .+; rationale: /);
  });
});
