import { describe, expect, it } from "vitest";
import {
  isCredentialUsable,
  parseSubscriptionCredential,
} from "../../../src/core/credentials/claude-code-payload.js";
import {
  CLAUDE_CODE_OAUTH_KEY,
  TOKEN_EXPIRY_SKEW_MS,
} from "../../../src/core/config/constants.js";

const NOW = 1_700_000_000_000;

function payload(fields: Record<string, unknown>): unknown {
  return { [CLAUDE_CODE_OAUTH_KEY]: fields };
}

describe("parseSubscriptionCredential", () => {
  it("reads the full credential shape Claude Code stores", () => {
    const credential = parseSubscriptionCredential(
      payload({
        accessToken: "sk-ant-oat01-example",
        refreshToken: "sk-ant-ort01-example",
        expiresAt: NOW,
        subscriptionType: "pro",
        rateLimitTier: "default_claude_ai",
        scopes: ["user:inference"],
      }),
    );

    expect(credential).toEqual({
      accessToken: "sk-ant-oat01-example",
      expiresAt: NOW,
      subscriptionType: "pro",
      rateLimitTier: "default_claude_ai",
    });
  });

  it("does not carry the refresh token — signposts never refreshes this credential", () => {
    const credential = parseSubscriptionCredential(
      payload({ accessToken: "token-value", refreshToken: "refresh-value" }),
    );
    expect(JSON.stringify(credential)).not.toContain("refresh-value");
  });

  it("optional fields absent -> undefined, not a throw", () => {
    expect(parseSubscriptionCredential(payload({ accessToken: "token-value" }))).toEqual({
      accessToken: "token-value",
      expiresAt: undefined,
      subscriptionType: undefined,
      rateLimitTier: undefined,
    });
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "not an object"],
    ["an empty object", {}],
    ["a null oauth block", { [CLAUDE_CODE_OAUTH_KEY]: null }],
    ["a non-object oauth block", { [CLAUDE_CODE_OAUTH_KEY]: "nope" }],
  ])("returns undefined for %s", (_label, input) => {
    expect(parseSubscriptionCredential(input)).toBeUndefined();
  });

  it("returns undefined when the access token is missing, empty, or not a string", () => {
    expect(parseSubscriptionCredential(payload({}))).toBeUndefined();
    expect(parseSubscriptionCredential(payload({ accessToken: "" }))).toBeUndefined();
    expect(parseSubscriptionCredential(payload({ accessToken: 42 }))).toBeUndefined();
  });

  it("ignores a non-numeric or non-finite expiry rather than rejecting the credential", () => {
    expect(
      parseSubscriptionCredential(payload({ accessToken: "token-value", expiresAt: "soon" }))
        ?.expiresAt,
    ).toBeUndefined();
    expect(
      parseSubscriptionCredential(payload({ accessToken: "token-value", expiresAt: Infinity }))
        ?.expiresAt,
    ).toBeUndefined();
  });
});

describe("isCredentialUsable", () => {
  const base = { accessToken: "token-value", subscriptionType: undefined, rateLimitTier: undefined };

  it("no stated expiry is usable — absence is not evidence of expiry", () => {
    expect(isCredentialUsable({ ...base, expiresAt: undefined }, NOW)).toBe(true);
  });

  it("comfortably in the future is usable", () => {
    expect(isCredentialUsable({ ...base, expiresAt: NOW + TOKEN_EXPIRY_SKEW_MS * 10 }, NOW)).toBe(
      true,
    );
  });

  it("already past is not usable", () => {
    expect(isCredentialUsable({ ...base, expiresAt: NOW - 1 }, NOW)).toBe(false);
  });

  it("inside the skew window is not usable, so it cannot die mid-run", () => {
    expect(isCredentialUsable({ ...base, expiresAt: NOW + TOKEN_EXPIRY_SKEW_MS }, NOW)).toBe(false);
    expect(isCredentialUsable({ ...base, expiresAt: NOW + TOKEN_EXPIRY_SKEW_MS + 1 }, NOW)).toBe(
      true,
    );
  });
});
