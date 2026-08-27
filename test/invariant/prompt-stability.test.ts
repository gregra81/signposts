// Tier 5 scan: prompt stability.
//
// 16-build-plan.md asks for the mechanical check behind prompt caching —
// "assert each of the four system prompts is byte-identical across every call
// in a run", rather than trusting that nobody interpolated a timestamp, a
// session id, or a repo name into the system turn. A single varying byte
// costs the cache hit on every subsequent call (08-models-and-credentials.md).
//
// The fixture is replayed twice: once for within-run identity, and again to
// catch a value that is stable inside a process but varies between them.

import { describe, expect, it } from "vitest";
import { FixtureModelProvider, fixtureKey } from "../../src/io/model/fixture-provider.js";
import { systemPromptFor } from "../../src/core/prompts/system.js";
import type { JSONSchema, ModelProvider, NodeName, ToolDef, Usage } from "../../src/core/model/types.js";

const MODELS: Record<NodeName, string> = {
  extract: "claude-fixture-extract",
  critic: "claude-fixture-critic",
  classify: "claude-fixture-classify",
  resolve: "claude-fixture-resolve",
};

const USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  model: "claude-fixture",
  costUsd: 0,
};

/**
 * One pass of the graph's model calls, in order. Every node appears more than
 * once — a prompt that varies per call only shows up when the same node is
 * asked twice.
 */
const FIXTURE_CALLS: ReadonlyArray<{ node: NodeName; user: string }> = [
  { node: "extract", user: "Repository: acme/api\n\nTranscript:\nfirst chunk" },
  { node: "extract", user: "Repository: acme/api\n\nTranscript:\nsecond chunk" },
  { node: "critic", user: "Repository: acme/api\n\nCandidates:\n[]" },
  { node: "critic", user: "Repository: acme/api\n\nCandidates:\n[{}]" },
  { node: "classify", user: "Candidate:\n{}\n\nExisting neighbours:\n[]" },
  { node: "classify", user: "Candidate:\n{}\n\nExisting neighbours:\n[{}]" },
  { node: "resolve", user: "Repository: acme/api\n\nNew claim:\n{}\n\nExisting claim:\n{}" },
  { node: "resolve", user: "Repository: acme/api\n\nNew claim:\n{}\n\nExisting claim:\n{ }" },
];

/** Delegates to the fixtures, keeping the system turn it was handed. */
class CapturingProvider implements ModelProvider {
  readonly systems: Array<{ node: NodeName; system: string }> = [];
  private readonly inner: ModelProvider;

  constructor(inner: ModelProvider) {
    this.inner = inner;
  }

  async structured<T>(req: {
    node: NodeName;
    system: string;
    user: string;
    schema: JSONSchema;
    batchable?: boolean;
    tools?: ToolDef[];
  }): Promise<{ value: T; usage: Usage }> {
    this.systems.push({ node: req.node, system: req.system });
    return this.inner.structured<T>(req);
  }
}

function fixtures(): Record<string, { value: unknown; usage: Usage }> {
  const recorded: Record<string, { value: unknown; usage: Usage }> = {};
  for (const call of FIXTURE_CALLS) {
    const key = fixtureKey(call.node, MODELS[call.node], systemPromptFor(call.node), call.user);
    recorded[key] = { value: {}, usage: USAGE };
  }
  return recorded;
}

/**
 * Replays the fixture. The lookup key includes the system turn, so a prompt
 * that differs by one byte from the recorded one is a fixture miss and throws
 * before the byte comparison below ever runs.
 */
async function runFixture(): Promise<Array<{ node: NodeName; system: string }>> {
  const provider = new CapturingProvider(new FixtureModelProvider(fixtures(), MODELS));
  for (const call of FIXTURE_CALLS) {
    await provider.structured({
      node: call.node,
      system: systemPromptFor(call.node),
      user: call.user,
      schema: {},
    });
  }
  return provider.systems;
}

describe("prompt stability", () => {
  it("sends one byte-identical system turn per node, in a run and across runs", async () => {
    const first = await runFixture();
    const second = await runFixture();

    expect(first).toHaveLength(FIXTURE_CALLS.length);
    expect(second).toHaveLength(FIXTURE_CALLS.length);

    const canonical = new Map<NodeName, Buffer>();
    for (const [index, call] of first.entries()) {
      const replay = second[index];
      const bytes = Buffer.from(call.system, "utf8");
      const expected = canonical.get(call.node) ?? bytes;
      canonical.set(call.node, expected);

      expect(bytes.equals(expected)).toBe(true);
      expect(replay).toBeDefined();
      expect(Buffer.from(replay!.system, "utf8").equals(expected)).toBe(true);
      expect(replay!.node).toBe(call.node);
    }

    expect([...canonical.keys()].sort()).toEqual(["classify", "critic", "extract", "resolve"]);
  });
});
