// Behaviour tests for credential detection (08-models-and-credentials.md).
// Real filesystem, temp home dir, injected env/platform/clock — no mocking.
//
// `platform` is forced to a non-darwin value so these exercise the on-disk
// credential path deterministically. The macOS Keychain branch is not covered
// here: it would require writing to the developer's real login Keychain under
// the same service name Claude Code uses, which is not something a test suite
// should do.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gatherAuthFacts, resolveCredential } from "../../../src/io/credentials/index.js";
import type { AuthPreference } from "../../../src/core/credentials/chain.js";
import {
  ANTHROPIC_CONFIG_DIRNAME,
  ANTHROPIC_CREDENTIALS_DIRNAME,
  ANTHROPIC_DEFAULT_PROFILE,
  AUTH_CHAIN,
  AUTH_METHOD_AUTO,
  CLAUDE_CODE_CREDENTIALS_FILE,
  CLAUDE_CODE_OAUTH_KEY,
  SHARED_QUOTA_TIER,
} from "../../../src/core/config/constants.js";

const [SUBSCRIPTION, API_KEY, AUTH_TOKEN, CONSOLE_PROFILE] = AUTH_CHAIN;

const LINUX = "linux";
const NOW = 1_700_000_000_000;
const FAR_FUTURE = NOW + 60 * 60 * 1000;
const ACCOUNT = "test-user";
const TOKEN = "sk-ant-oat01-test-token";

describe("credential detection", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(path.join(tmpdir(), "signposts-creds-home-"));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  function writeSubscription(fields: Record<string, unknown>): void {
    const file = path.join(homeDir, CLAUDE_CODE_CREDENTIALS_FILE);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ [CLAUDE_CODE_OAUTH_KEY]: fields }), "utf8");
  }

  function writeConsoleProfile(): void {
    const dir = path.join(homeDir, ANTHROPIC_CONFIG_DIRNAME, ANTHROPIC_CREDENTIALS_DIRNAME);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${ANTHROPIC_DEFAULT_PROFILE}.json`), "{}", "utf8");
  }

  function gather(
    env: Record<string, string | undefined> = {},
    preference: AuthPreference = AUTH_METHOD_AUTO,
  ) {
    return gatherAuthFacts(
      { homeDir, env, platform: LINUX, account: ACCOUNT, now: NOW },
      preference,
    );
  }

  it("an empty machine has no credentials at all", () => {
    const facts = gather();
    expect(facts.selected).toBe("none");
    expect(facts.usable).toEqual([]);
    expect(facts.subscriptionExpired).toBe(false);
  });

  it("a signed-in Claude subscription is enough on its own — no env var, no console account", () => {
    writeSubscription({
      accessToken: TOKEN,
      expiresAt: FAR_FUTURE,
      subscriptionType: "pro",
      rateLimitTier: SHARED_QUOTA_TIER,
    });

    const facts = gather();
    expect(facts.selected).toBe(SUBSCRIPTION);
    expect(facts.subscriptionType).toBe("pro");
    expect(facts.rateLimitTier).toBe(SHARED_QUOTA_TIER);
  });

  it("the subscription wins over an API key by default, and both are reported usable", () => {
    writeSubscription({ accessToken: TOKEN, expiresAt: FAR_FUTURE });

    const facts = gather({ ANTHROPIC_API_KEY: "sk-ant-api-key" });
    expect(facts.selected).toBe(SUBSCRIPTION);
    expect(facts.usable).toEqual([SUBSCRIPTION, API_KEY]);
  });

  it("pinning api-key overrides the subscription default", () => {
    writeSubscription({ accessToken: TOKEN, expiresAt: FAR_FUTURE });

    const facts = gather({ ANTHROPIC_API_KEY: "sk-ant-api-key" }, API_KEY);
    expect(facts.selected).toBe(API_KEY);
  });

  it("an expired subscription is reported as expired and does not get selected", () => {
    writeSubscription({ accessToken: TOKEN, expiresAt: NOW - 1 });

    const facts = gather({ ANTHROPIC_API_KEY: "sk-ant-api-key" });
    expect(facts.subscriptionExpired).toBe(true);
    expect(facts.selected).toBe(API_KEY);
    expect(facts.usable).toEqual([API_KEY]);
  });

  it("detects each env credential, preferring the API key over the auth token", () => {
    expect(gather({ ANTHROPIC_AUTH_TOKEN: "token-value" }).selected).toBe(AUTH_TOKEN);
    expect(
      gather({ ANTHROPIC_API_KEY: "key-value", ANTHROPIC_AUTH_TOKEN: "token-value" }).selected,
    ).toBe(API_KEY);
  });

  it("treats an empty env var as unset, the way CI writes `FOO=`", () => {
    expect(gather({ ANTHROPIC_API_KEY: "" }).selected).toBe("none");
  });

  it("detects an `ant auth login` profile as the last link in the chain", () => {
    writeConsoleProfile();
    expect(gather().selected).toBe(CONSOLE_PROFILE);
  });

  it("honours ANTHROPIC_CONFIG_DIR when locating the profile", () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "signposts-ant-config-"));
    mkdirSync(path.join(configDir, ANTHROPIC_CREDENTIALS_DIRNAME), { recursive: true });
    writeFileSync(
      path.join(configDir, ANTHROPIC_CREDENTIALS_DIRNAME, `${ANTHROPIC_DEFAULT_PROFILE}.json`),
      "{}",
      "utf8",
    );

    try {
      expect(gather({ ANTHROPIC_CONFIG_DIR: configDir }).selected).toBe(CONSOLE_PROFILE);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("looks up the profile named by ANTHROPIC_PROFILE", () => {
    const dir = path.join(homeDir, ANTHROPIC_CONFIG_DIRNAME, ANTHROPIC_CREDENTIALS_DIRNAME);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "work.json"), "{}", "utf8");

    expect(gather({ ANTHROPIC_PROFILE: "work" }).selected).toBe(CONSOLE_PROFILE);
    expect(gather().selected).toBe("none");
  });

  it("survives a corrupt Claude Code credential file", () => {
    const file = path.join(homeDir, CLAUDE_CODE_CREDENTIALS_FILE);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{ not json", "utf8");

    expect(() => gather()).not.toThrow();
    expect(gather().selected).toBe("none");
  });
});

describe("resolveCredential", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(path.join(tmpdir(), "signposts-creds-home-"));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  function resolve(
    env: Record<string, string | undefined> = {},
    preference: AuthPreference = AUTH_METHOD_AUTO,
  ) {
    return resolveCredential(
      { homeDir, env, platform: LINUX, account: ACCOUNT, now: NOW },
      preference,
    );
  }

  it("returns undefined when nothing is available", () => {
    expect(resolve()).toBeUndefined();
  });

  it("carries the bearer token for the subscription — the SDK cannot find it alone", () => {
    const file = path.join(homeDir, CLAUDE_CODE_CREDENTIALS_FILE);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ [CLAUDE_CODE_OAUTH_KEY]: { accessToken: TOKEN, expiresAt: FAR_FUTURE } }),
      "utf8",
    );

    expect(resolve()).toEqual({ method: SUBSCRIPTION, accessToken: TOKEN });
  });

  it("carries no token for methods the SDK resolves itself", () => {
    expect(resolve({ ANTHROPIC_API_KEY: "key-value" })).toEqual({ method: API_KEY });
    expect(resolve({ ANTHROPIC_AUTH_TOKEN: "token-value" })).toEqual({ method: AUTH_TOKEN });
  });
});
