// callStructured — the one path from the graph to a model.
//
// Two things are asserted here that no behaviour test can reach: a request
// carries the node's own system prompt and schema and nothing else, and the
// message a schema violation throws names the node and every offending path.
// That throw is all anyone gets when an answer comes back the wrong shape.

import { describe, expect, it } from "vitest";
import { callStructured } from "../../../src/graph/llm.js";
import { systemPromptFor } from "../../../src/core/prompts/system.js";
import { jsonSchemaFor } from "../../../src/core/graph/node-io.js";
import type { ModelProvider } from "../../../src/core/model/types.js";

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

  async structured<T>(req: Request): Promise<T> {
    this.requests.push(req);
    return this.reply as T;
  }
}

const VALID_CLASSIFICATION = {
  tempId: "t1",
  kind: "NOVEL",
  rationale: "Nothing like it recorded.",
};

async function classifyWith(model: ModelProvider) {
  return callStructured({ model, node: "classify", user: "u" });
}

describe("the request", () => {
  it("sends the node's own system prompt and JSON Schema", async () => {
    const model = new RecordingProvider(VALID_CLASSIFICATION);

    await classifyWith(model);

    expect(model.sent.system).toBe(systemPromptFor("classify"));
    expect(model.sent.schema).toEqual(jsonSchemaFor("classify"));
    expect(model.sent.user).toBe("u");
  });

  it("carries nothing else: the request is the node, the two turns and the schema", async () => {
    const model = new RecordingProvider(VALID_CLASSIFICATION);

    await classifyWith(model);

    expect(Object.keys(model.sent).sort()).toEqual(["node", "schema", "system", "user"]);
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
