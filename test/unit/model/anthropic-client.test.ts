// Every one of the four auth methods must pin. The SDK resolves credentials
// in a fixed order — ANTHROPIC_API_KEY, then ANTHROPIC_AUTH_TOKEN, then the
// `ant` profile — so the interesting case for each is the one where a
// higher-ranked credential is sitting in the environment. That is the shape
// of the bug these cover: `auth.method` pinned, an old key still exported,
// every call billed to the wrong account while `doctor` reported the pin.
//
// No network: constructing a client sends nothing.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAnthropicClient } from "../../../src/io/model/anthropic-client.js";
import { AUTH_CHAIN } from "../../../src/core/config/constants.js";

const [SUBSCRIPTION, API_KEY, AUTH_TOKEN, CONSOLE_PROFILE] = AUTH_CHAIN;

const ENV_API_KEY = "sk-ant-from-the-environment";
const ENV_AUTH_TOKEN = "auth-token-from-the-environment";

describe("createAnthropicClient — a pinned method outranks the environment", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    };
    // The condition under test: both env credentials present, outranking
    // whatever the user pinned.
    process.env.ANTHROPIC_API_KEY = ENV_API_KEY;
    process.env.ANTHROPIC_AUTH_TOKEN = ENV_AUTH_TOKEN;
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it("sends the subscription token as a bearer, with no api key to outrank it", () => {
    const client = createAnthropicClient({ method: SUBSCRIPTION, accessToken: "oauth-token" });

    expect(client.authToken).toBe("oauth-token");
    expect(client.apiKey).toBeNull();
  });

  it("uses the pinned api key, not the auth token beside it", () => {
    const client = createAnthropicClient({ method: API_KEY, apiKey: "sk-ant-pinned" });

    expect(client.apiKey).toBe("sk-ant-pinned");
    expect(client.authToken).toBeNull();
  });

  it("uses the pinned auth token even though an api key outranks it in the SDK", () => {
    const client = createAnthropicClient({ method: AUTH_TOKEN, authToken: "pinned-auth-token" });

    expect(client.authToken).toBe("pinned-auth-token");
    expect(client.apiKey).toBeNull();
  });

  it("pins the console profile, which suppresses both credential env vars", () => {
    const client = createAnthropicClient({ method: CONSOLE_PROFILE, profile: "work" });

    // The SDK exposes no `profile` getter, so this is the observable proof:
    // passing `profile` makes it skip ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN
    // entirely. A bare `new Anthropic()` here would have picked up ENV_API_KEY.
    expect(client.apiKey).toBeNull();
    expect(client.authToken).toBeNull();
  });

  it("never falls back to the environment for any method", () => {
    const clients = [
      createAnthropicClient({ method: SUBSCRIPTION, accessToken: "oauth-token" }),
      createAnthropicClient({ method: API_KEY, apiKey: "sk-ant-pinned" }),
      createAnthropicClient({ method: AUTH_TOKEN, authToken: "pinned-auth-token" }),
      createAnthropicClient({ method: CONSOLE_PROFILE, profile: "work" }),
    ];

    for (const client of clients) {
      expect(client.apiKey).not.toBe(ENV_API_KEY);
      expect(client.authToken).not.toBe(ENV_AUTH_TOKEN);
    }
  });
});
