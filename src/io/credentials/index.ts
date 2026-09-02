// Gathers what every auth method in AUTH_CHAIN can offer on this machine,
// and turns the winner into the credential a model client would use.
//
// Only the Claude subscription needs signposts to carry a token: the SDK
// resolves API keys, auth tokens, and `ant auth login` profiles itself, so
// for those three we report availability and then get out of the way. That
// asymmetry is the whole reason this module exists.
//
// `env` is a parameter, not `process.env` — the composition root reads the
// environment once (R7) and passes it down.

import {
  availableMethods,
  resolveAuthMethod,
  type AuthAvailability,
  type AuthMethod,
  type AuthPreference,
  type ResolvedAuthMethod,
} from "../../core/credentials/chain.ts";
import { AUTH_CHAIN } from "../../core/config/constants.ts";
import { isCredentialUsable } from "../../core/credentials/claude-code-payload.ts";
import { readSubscriptionCredential } from "./claude-code.ts";
import { activeConsoleProfile, hasConsoleProfile } from "./console-profile.ts";

// Destructured from the tuple so each method name stays a single spelling
// owned by constants.ts, with its literal type preserved.
const [SUBSCRIPTION, API_KEY, AUTH_TOKEN, CONSOLE_PROFILE] = AUTH_CHAIN;

const API_KEY_ENV = "ANTHROPIC_API_KEY";
const AUTH_TOKEN_ENV = "ANTHROPIC_AUTH_TOKEN";

export interface GatherAuthInput {
  homeDir: string;
  env: Readonly<Record<string, string | undefined>>;
  platform: string;
  /** OS username — the Keychain account Claude Code stores its item under. */
  account: string;
  /** Epoch milliseconds, for the subscription token's expiry check. */
  now: number;
}

export interface AuthFacts {
  available: AuthAvailability;
  /** The method that would actually be used, honouring `auth.method`. */
  selected: ResolvedAuthMethod;
  /** Every method with a credential behind it, in chain order. */
  usable: readonly AuthMethod[];
  /** Subscription tier ("pro", "max", …) when a subscription credential was found. */
  subscriptionType: string | undefined;
  /**
   * Subscription rate-limit tier. `default_claude_ai` means signposts' model
   * calls draw on the same quota as the user's interactive Claude Code work —
   * `doctor` says so out loud rather than letting them find out.
   */
  rateLimitTier: string | undefined;
  /**
   * True when a subscription credential exists but has expired. Distinct from
   * "absent": the fix is to open Claude Code, not to sign up for anything.
   */
  subscriptionExpired: boolean;
}

function envPresent(env: GatherAuthInput["env"], name: string): boolean {
  const value = env[name];
  return value !== undefined && value !== "";
}

/** Reads every credential source once. Never throws — see the readers' notes. */
export function gatherAuthFacts(input: GatherAuthInput, preference: AuthPreference): AuthFacts {
  const subscription = readSubscriptionCredential({
    homeDir: input.homeDir,
    platform: input.platform,
    account: input.account,
  });
  const subscriptionUsable =
    subscription !== undefined && isCredentialUsable(subscription, input.now);

  const available: AuthAvailability = {
    [SUBSCRIPTION]: subscriptionUsable,
    [API_KEY]: envPresent(input.env, API_KEY_ENV),
    [AUTH_TOKEN]: envPresent(input.env, AUTH_TOKEN_ENV),
    [CONSOLE_PROFILE]: hasConsoleProfile({ homeDir: input.homeDir, env: input.env }),
  };

  return {
    available,
    selected: resolveAuthMethod(available, preference),
    usable: availableMethods(available),
    subscriptionType: subscription?.subscriptionType,
    rateLimitTier: subscription?.rateLimitTier,
    subscriptionExpired: subscription !== undefined && !subscriptionUsable,
  };
}

/**
 * The selected method plus whatever the SDK client needs to be pinned to it.
 *
 * Exactly one of the four value fields is set, matching `method`. They are
 * carried rather than left to the SDK's own resolution order because that
 * order is fixed — ANTHROPIC_API_KEY outranks ANTHROPIC_AUTH_TOKEN outranks
 * the `ant` profile — and a bare client therefore ignores the pin whenever a
 * higher-ranked credential happens to be exported. src/core/credentials/
 * chain.ts states the contract that would break: a pinned method "is never
 * silently downgraded to another method, because the whole point of pinning
 * is choosing which account gets billed."
 *
 * Reading the environment here is R7-clean: `input.env` was handed down from
 * the composition root, not read from `process.env`.
 */
export interface ModelCredential {
  method: AuthMethod;
  /**
   * Bearer token, set only for the Claude subscription — the SDK cannot read
   * Claude Code's credential store, so signposts has to hand it over. Send it
   * as `Authorization: Bearer` with the `oauth-2025-04-20` beta header, never
   * as `x-api-key`.
   */
  accessToken?: string;
  /** ANTHROPIC_API_KEY's value, set only for `api-key`. */
  apiKey?: string;
  /** ANTHROPIC_AUTH_TOKEN's value, set only for `auth-token`. */
  authToken?: string;
  /** The `ant` profile name, set only for `console-profile`. */
  profile?: string;
}

/**
 * The credential for the selected method, or undefined when nothing is
 * available. Re-reads the subscription token rather than caching it: Claude
 * Code refreshes continuously, so the freshest read at call time is the one
 * most likely to still be valid.
 */
export function resolveCredential(
  input: GatherAuthInput,
  preference: AuthPreference,
): ModelCredential | undefined {
  const facts = gatherAuthFacts(input, preference);
  if (facts.selected === "none") {
    return undefined;
  }
  if (facts.selected === API_KEY) {
    return { method: API_KEY, apiKey: input.env[API_KEY_ENV] ?? "" };
  }
  if (facts.selected === AUTH_TOKEN) {
    return { method: AUTH_TOKEN, authToken: input.env[AUTH_TOKEN_ENV] ?? "" };
  }
  if (facts.selected === CONSOLE_PROFILE) {
    return { method: CONSOLE_PROFILE, profile: activeConsoleProfile(input.env) };
  }

  const subscription = readSubscriptionCredential({
    homeDir: input.homeDir,
    platform: input.platform,
    account: input.account,
  });
  return subscription === undefined
    ? undefined
    : { method: SUBSCRIPTION, accessToken: subscription.accessToken };
}
