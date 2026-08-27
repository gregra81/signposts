// Parses the JSON payload Claude Code stores for a signed-in Claude
// subscription — from the macOS Keychain item or the on-disk fallback, both
// read by src/io/credentials/claude-code.ts. Pure: it takes already-parsed
// JSON and the current time, so it never touches the Keychain, the
// filesystem, or the clock.
//
// The shape (verified against a live Pro credential on 2026-08-27):
//
//   { "claudeAiOauth": { accessToken, refreshToken, expiresAt,
//                        refreshTokenExpiresAt, scopes, subscriptionType,
//                        rateLimitTier } }
//
// Claude Code owns this credential and refreshes it continuously; signposts
// only reads it. A token that is expired (or about to be) is reported as
// absent rather than refreshed here — refreshing a credential we don't own
// is 08-models-and-credentials.md's second objection, and the fix is to tell
// the user to run Claude Code, not to mint tokens behind its back.
//
// `accessToken` is a secret. It is returned to the caller and never logged;
// note that its `sk-ant-` prefix is already in TOKEN_PREFIXES, so the
// redactor catches it if one ever reaches a transcript.

import { CLAUDE_CODE_OAUTH_KEY, TOKEN_EXPIRY_SKEW_MS } from "../config/constants.ts";

export interface SubscriptionCredential {
  accessToken: string;
  /** Epoch milliseconds, or undefined when the payload omits it. */
  expiresAt: number | undefined;
  /** e.g. "pro", "max" — reported by `doctor`, never used to gate anything. */
  subscriptionType: string | undefined;
  /**
   * e.g. "default_claude_ai". Surfaced so `doctor` can warn that background
   * runs share the quota backing interactive Claude Code work.
   */
  rateLimitTier: string | undefined;
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Returns the credential, or undefined when the payload is missing,
 * malformed, or carries no access token. Never throws: this runs inside
 * `doctor`, which must complete on a broken machine.
 */
export function parseSubscriptionCredential(payload: unknown): SubscriptionCredential | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const oauth = (payload as Record<string, unknown>)[CLAUDE_CODE_OAUTH_KEY];
  if (typeof oauth !== "object" || oauth === null) {
    return undefined;
  }

  const fields = oauth as Record<string, unknown>;
  const accessToken = readString(fields, "accessToken");
  if (accessToken === undefined) {
    return undefined;
  }

  const rawExpiry = fields["expiresAt"];

  return {
    accessToken,
    expiresAt: typeof rawExpiry === "number" && Number.isFinite(rawExpiry) ? rawExpiry : undefined,
    subscriptionType: readString(fields, "subscriptionType"),
    rateLimitTier: readString(fields, "rateLimitTier"),
  };
}

/**
 * A credential with no stated expiry is treated as usable — the payload is
 * Claude Code's to define, and absence of the field is not evidence of
 * expiry. TOKEN_EXPIRY_SKEW_MS of headroom keeps a token that dies mid-run
 * from being picked up in the first place.
 */
export function isCredentialUsable(credential: SubscriptionCredential, now: number): boolean {
  return credential.expiresAt === undefined || credential.expiresAt - TOKEN_EXPIRY_SKEW_MS > now;
}
