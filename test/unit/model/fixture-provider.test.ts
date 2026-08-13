import { describe, expect, it } from "vitest";
import {
  FixtureModelProvider,
  fixtureKey,
} from "../../../src/io/model/fixture-provider.js";
import type { NodeName, Usage } from "../../../src/core/model/types.js";

const MODELS: Record<NodeName, string> = {
  extract: "claude-model-a",
  critic: "claude-model-a",
  classify: "claude-model-a",
  resolve: "claude-model-a",
};

const USAGE: Usage = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  model: "claude-model-a",
  costUsd: 0.001,
};

describe("FixtureModelProvider", () => {
  it("returns the recorded value and usage for a matching request", async () => {
    const key = fixtureKey("extract", MODELS.extract, "system prompt", "user input");
    const provider = new FixtureModelProvider(
      { [key]: { value: { claim: "hello" }, usage: USAGE } },
      MODELS,
    );

    const result = await provider.structured<{ claim: string }>({
      node: "extract",
      system: "system prompt",
      user: "user input",
      schema: {},
    });

    expect(result.value).toEqual({ claim: "hello" });
    expect(result.usage).toEqual(USAGE);
  });

  it("throws on a request with no recorded fixture", async () => {
    const provider = new FixtureModelProvider({}, MODELS);

    await expect(
      provider.structured({
        node: "critic",
        system: "system prompt",
        user: "user input",
        schema: {},
      }),
    ).rejects.toThrow(/critic/);
  });

  it("produces different fixture keys for the same node with different model ids", () => {
    const keyA = fixtureKey("classify", "model-a", "system prompt", "user input");
    const keyB = fixtureKey("classify", "model-b", "system prompt", "user input");

    expect(keyA).not.toBe(keyB);
  });
});
