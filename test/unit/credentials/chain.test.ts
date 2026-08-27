import { describe, expect, it } from "vitest";
import {
  availableMethods,
  resolveAuthMethod,
  NO_AUTH_AVAILABLE,
  type AuthAvailability,
} from "../../../src/core/credentials/chain.js";
import { AUTH_CHAIN, AUTH_METHOD_AUTO } from "../../../src/core/config/constants.js";

const [SUBSCRIPTION, API_KEY, AUTH_TOKEN, CONSOLE_PROFILE] = AUTH_CHAIN;

function withAvailable(...methods: readonly (typeof AUTH_CHAIN)[number][]): AuthAvailability {
  return { ...NO_AUTH_AVAILABLE, ...Object.fromEntries(methods.map((m) => [m, true])) };
}

describe("resolveAuthMethod (auto)", () => {
  it("nothing available -> none", () => {
    expect(resolveAuthMethod(NO_AUTH_AVAILABLE, AUTH_METHOD_AUTO)).toBe("none");
  });

  it("prefers the Claude subscription over every other method", () => {
    const all = withAvailable(SUBSCRIPTION, API_KEY, AUTH_TOKEN, CONSOLE_PROFILE);
    expect(resolveAuthMethod(all, AUTH_METHOD_AUTO)).toBe(SUBSCRIPTION);
  });

  it("walks the chain in order when higher-priority methods are absent", () => {
    expect(resolveAuthMethod(withAvailable(API_KEY, AUTH_TOKEN), AUTH_METHOD_AUTO)).toBe(API_KEY);
    expect(resolveAuthMethod(withAvailable(AUTH_TOKEN, CONSOLE_PROFILE), AUTH_METHOD_AUTO)).toBe(
      AUTH_TOKEN,
    );
    expect(resolveAuthMethod(withAvailable(CONSOLE_PROFILE), AUTH_METHOD_AUTO)).toBe(
      CONSOLE_PROFILE,
    );
  });

  it("picks each method when it is the only one available", () => {
    for (const method of AUTH_CHAIN) {
      expect(resolveAuthMethod(withAvailable(method), AUTH_METHOD_AUTO)).toBe(method);
    }
  });
});

describe("resolveAuthMethod (pinned)", () => {
  it("uses the pinned method even when a higher-priority one is available", () => {
    const both = withAvailable(SUBSCRIPTION, API_KEY);
    expect(resolveAuthMethod(both, API_KEY)).toBe(API_KEY);
  });

  it("reports none rather than falling back when the pinned method is absent", () => {
    // The point of pinning is choosing which account is billed, so a silent
    // downgrade to the subscription would bill the wrong one.
    const onlySubscription = withAvailable(SUBSCRIPTION);
    expect(resolveAuthMethod(onlySubscription, API_KEY)).toBe("none");
  });

  it("honours a pin for every method in the chain", () => {
    for (const method of AUTH_CHAIN) {
      const all = withAvailable(...AUTH_CHAIN);
      expect(resolveAuthMethod(all, method)).toBe(method);
    }
  });
});

describe("availableMethods", () => {
  it("is empty when nothing is available", () => {
    expect(availableMethods(NO_AUTH_AVAILABLE)).toEqual([]);
  });

  it("lists only available methods, in chain order", () => {
    expect(availableMethods(withAvailable(CONSOLE_PROFILE, API_KEY))).toEqual([
      API_KEY,
      CONSOLE_PROFILE,
    ]);
  });
});
