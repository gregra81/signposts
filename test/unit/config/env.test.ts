import { describe, expect, it } from "vitest";
import { parseEnvLayer } from "../../../src/core/config/env.js";

describe("parseEnvLayer", () => {
  it("ignores env vars it doesn't recognise", () => {
    expect(parseEnvLayer({ SIGNPOSTS_NOT_A_REAL_KEY: "1", UNRELATED: "x" })).toEqual({});
  });

  it("returns an empty layer when nothing is set", () => {
    expect(parseEnvLayer({})).toEqual({});
  });

  it("coerces a number leaf", () => {
    expect(parseEnvLayer({ SIGNPOSTS_RETRIEVAL_K: "8" })).toEqual({ retrieval: { k: 8 } });
  });

  it("coerces a boolean leaf", () => {
    expect(parseEnvLayer({ SIGNPOSTS_GIT_AUTO_MERGE: "true" })).toEqual({
      git: { auto_merge: true },
    });
    expect(parseEnvLayer({ SIGNPOSTS_GIT_AUTO_MERGE: "false" })).toEqual({
      git: { auto_merge: false },
    });
  });

  it("leaves a string leaf as-is", () => {
    expect(parseEnvLayer({ SIGNPOSTS_GIT_BRANCH_PATTERN: "knowledge/{author_slug}" })).toEqual({
      git: { branch_pattern: "knowledge/{author_slug}" },
    });
  });

  it("throws on an unparseable number", () => {
    expect(() => parseEnvLayer({ SIGNPOSTS_RETRIEVAL_K: "not-a-number" })).toThrow(
      /SIGNPOSTS_RETRIEVAL_K/,
    );
  });

  it("throws on an unparseable boolean", () => {
    expect(() => parseEnvLayer({ SIGNPOSTS_GIT_AUTO_MERGE: "yes" })).toThrow(
      /SIGNPOSTS_GIT_AUTO_MERGE/,
    );
  });

  it("rejects an empty-string number leaf rather than silently treating it as 0", () => {
    // `FOO=` (empty) is the standard CI way to say "unset". Number("")
    // is 0, so without an explicit check this would fail downstream as
    // "too small" instead of naming the real problem.
    expect(() => parseEnvLayer({ SIGNPOSTS_RETRIEVAL_K: "" })).toThrow(
      /SIGNPOSTS_RETRIEVAL_K is set but empty/,
    );
  });

  it("rejects a whitespace-only number leaf as empty too", () => {
    expect(() => parseEnvLayer({ SIGNPOSTS_RETRIEVAL_K: "   " })).toThrow(
      /SIGNPOSTS_RETRIEVAL_K is set but empty/,
    );
  });

  it("rejects a non-finite number leaf", () => {
    expect(() => parseEnvLayer({ SIGNPOSTS_RETRIEVAL_K: "Infinity" })).toThrow(
      /SIGNPOSTS_RETRIEVAL_K/,
    );
    expect(() => parseEnvLayer({ SIGNPOSTS_RETRIEVAL_K: "-Infinity" })).toThrow(
      /SIGNPOSTS_RETRIEVAL_K/,
    );
  });

  it("only sets the leaves that were actually present in env, per-leaf", () => {
    const layer = parseEnvLayer({
      SIGNPOSTS_THRESHOLDS_IDLE_HOURS: "48",
    });
    expect(layer).toEqual({ thresholds: { idle_hours: 48 } });
  });

  it("combines multiple env vars across sections", () => {
    const layer = parseEnvLayer({
      SIGNPOSTS_RETRIEVAL_K: "10",
      SIGNPOSTS_GIT_BRANCH_PATTERN: "custom/{author_slug}",
      SIGNPOSTS_VERSION: "1",
    });
    expect(layer).toEqual({
      version: 1,
      retrieval: { k: 10 },
      git: { branch_pattern: "custom/{author_slug}" },
    });
  });
});
