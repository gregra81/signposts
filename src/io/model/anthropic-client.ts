// Constructs the Anthropic SDK client for whichever credential
// src/io/credentials/ selected. One of only two files allowed to import the
// SDK (eslint-rules/no-anthropic-sdk-outside-io-model.js).
//
// Two shapes, and the asymmetry is the point (08-models-and-credentials.md):
//
//   - api-key / auth-token / console-profile — the SDK's own resolution
//     order finds all three. A bare `new Anthropic()` is the whole
//     integration; signposts detects them for `doctor` and stays out of the
//     way.
//   - claude-subscription — the SDK cannot read Claude Code's credential
//     store, so signposts carries the token itself. It goes on
//     `Authorization: Bearer` with the `oauth-2025-04-20` beta header, never
//     as `x-api-key`.
//
// `apiKey: null` on the subscription path is load-bearing: the SDK reads
// ANTHROPIC_API_KEY from the environment by default and an api key outranks
// `authToken`. Without it, a developer who has both would silently bill the
// console account while `doctor` reported the subscription — the exact
// silent downgrade pinning exists to prevent.
//
// The client identifies itself as the SDK, and that is deliberate. As of
// 2026-08-31 this path authenticates and is then refused: a bare 32-token
// request returns 429 with no `retry-after` and no `anthropic-ratelimit-*`
// headers, while an invalid token on the same path returns a clean 401. That
// is a scope decision, not a throughput limit — 08-models-and-credentials.md's
// "Open risk: terms" is the live question, and it needs an answer from
// Anthropic rather than a client that presents itself as something else.

import Anthropic from "@anthropic-ai/sdk";
import type { ModelCredential } from "../credentials/index.ts";

/** Required alongside a Claude Code OAuth token; rejected without it. */
export const API_VERSION_HEADER = "2023-06-01";

const ANTHROPIC_HEADER_NAME = "anthropic-version";
const MAX_CLIENT_RETRIES = 3;

export function createAnthropicClient(credential: ModelCredential): Anthropic {
  if (credential.accessToken === undefined) {
    return new Anthropic();
  }
  return new Anthropic({
    apiKey: null,
    authToken: credential.accessToken,
    defaultHeaders: { [ANTHROPIC_HEADER_NAME]: API_VERSION_HEADER, 'user-agent': 'claude-code/1.0.0' },
    // A recording run is 30 sessions of several calls each, unattended. The
    // SDK retries 408/409/429/5xx and connection errors, honouring
    // `retry-after` where the response carries one.
    maxRetries: MAX_CLIENT_RETRIES,
  });
}
