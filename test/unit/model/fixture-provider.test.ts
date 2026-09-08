import { describe, expect, it } from "vitest";
import { FixtureModelProvider, fixtureKey } from "../../../src/io/model/fixture-provider.js";

describe("FixtureModelProvider", () => {
  it("returns the recorded reply for a matching request", async () => {
    const key = fixtureKey("extract", "system prompt", "user input");
    const provider = new FixtureModelProvider({ [key]: { claim: "hello" } });

    const value = await provider.structured<{ claim: string }>({
      node: "extract",
      system: "system prompt",
      user: "user input",
      schema: {},
    });

    expect(value).toEqual({ claim: "hello" });
  });

  it("throws on a request with no recorded fixture", async () => {
    const provider = new FixtureModelProvider({});

    await expect(
      provider.structured({
        node: "critic",
        system: "system prompt",
        user: "user input",
        schema: {},
      }),
    ).rejects.toThrow(/critic/);
  });

  it("returns a recorded null rather than treating it as a miss", async () => {
    // `key in fixtures` and not a truthiness check: a recorded reply may be
    // any JSON value, and a miss has to stay distinguishable from one.
    const key = fixtureKey("classify", "s", "u");
    const provider = new FixtureModelProvider({ [key]: null });

    await expect(
      provider.structured({ node: "classify", system: "s", user: "u", schema: {} }),
    ).resolves.toBeNull();
  });

  it("keys on the node, so the same prompts asked of two nodes do not collide", () => {
    expect(fixtureKey("classify", "system prompt", "user input")).not.toBe(
      fixtureKey("critic", "system prompt", "user input"),
    );
  });

  it("keys on the user turn, so two calls to one node stay separate", () => {
    expect(fixtureKey("classify", "system prompt", "first")).not.toBe(
      fixtureKey("classify", "system prompt", "second"),
    );
  });
});
