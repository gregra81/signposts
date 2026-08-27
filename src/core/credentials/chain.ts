// Which Anthropic credential signposts uses, given what's available on the
// machine and what the user pinned (08-models-and-credentials.md,
// "Credentials"). Pure: it takes presence booleans and a preference, and
// returns a method name. Detecting availability is src/io/credentials/*;
// phrasing the result for `doctor` is src/core/doctor/report.ts.
//
// The chain leads with the Claude subscription so that signing in to Claude
// Code is enough to run signposts — no console account, no key to paste. An
// explicit `auth.method` overrides the walk entirely: someone with both a
// subscription and an API account can pin the one they want billed.

import { AUTH_CHAIN, AUTH_METHOD_AUTO } from "../config/constants.ts";

/** One of the four methods signposts can authenticate with. */
export type AuthMethod = (typeof AUTH_CHAIN)[number];

/** What `resolveAuthMethod` settled on — "none" when nothing usable was found. */
export type ResolvedAuthMethod = AuthMethod | "none";

/** `auth.method` from config: walk the chain, or pin one method. */
export type AuthPreference = typeof AUTH_METHOD_AUTO | AuthMethod;

/** Whether each method has a usable credential behind it right now. */
export type AuthAvailability = Readonly<Record<AuthMethod, boolean>>;

/** Every method absent — the starting point for building an availability map. */
export const NO_AUTH_AVAILABLE: AuthAvailability = Object.freeze(
  Object.fromEntries(AUTH_CHAIN.map((method) => [method, false])),
) as AuthAvailability;

/**
 * A pinned method is used if available and reported as "none" if not — it is
 * never silently downgraded to another method, because the whole point of
 * pinning is choosing which account gets billed. `auto` takes the first
 * available method in AUTH_CHAIN order.
 */
export function resolveAuthMethod(
  available: AuthAvailability,
  preference: AuthPreference,
): ResolvedAuthMethod {
  if (preference !== AUTH_METHOD_AUTO) {
    return available[preference] ? preference : "none";
  }
  return AUTH_CHAIN.find((method) => available[method]) ?? "none";
}

/** Methods with a credential behind them, in chain order — what `doctor` lists as alternatives. */
export function availableMethods(available: AuthAvailability): readonly AuthMethod[] {
  return AUTH_CHAIN.filter((method) => available[method]);
}
