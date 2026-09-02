// Constructs the Anthropic SDK client for whichever credential
// src/io/credentials/ selected. One of only two files allowed to import the
// SDK (eslint-rules/no-anthropic-sdk-outside-io-model.js).
//
// One client per method, and every one of them pins (08-models-and-credentials
// .md). The SDK resolves credentials in a fixed order — ANTHROPIC_API_KEY,
// then ANTHROPIC_AUTH_TOKEN, then the `ant` profile — so a bare
// `new Anthropic()` uses whatever ranks highest in the environment, not what
// the user chose. A developer who pins `console-profile` while an old
// ANTHROPIC_API_KEY is still exported would have every call billed to the
// console account while `doctor` reported the profile: the exact silent
// downgrade src/core/credentials/chain.ts says pinning exists to prevent.
//
// So each branch below sets the field for its own method and nulls the ones
// that outrank it. `apiKey: null` is load-bearing on three of the four; on
// the console-profile path the SDK does it for us, skipping both credential
// env vars whenever `profile` is passed to the constructor.
//
// The subscription is still the odd one out in what it carries: the SDK
// cannot read Claude Code's credential store, so signposts hands over the
// token itself, on `Authorization: Bearer` with the `oauth-2025-04-20` beta
// header, never as `x-api-key`.
//
// The client identifies itself as the SDK, and that is deliberate. As of
// 2026-08-31 this path authenticates and is then refused: a bare 32-token
// request returns 429 with no `retry-after` and no `anthropic-ratelimit-*`
// headers, while an invalid token on the same path returns a clean 401. That
// is a scope decision, not a throughput limit — 08-models-and-credentials.md's
// "Open risk: terms" is the live question, and it needs an answer from
// Anthropic rather than a client that presents itself as something else.

import Anthropic from "@anthropic-ai/sdk";
import { AUTH_CHAIN } from "../../core/config/constants.ts";
import type { ModelCredential } from "../credentials/index.ts";

// Destructured from the tuple so each method name stays a single spelling
// owned by constants.ts, with its literal type preserved — same reason
// src/io/credentials/index.ts does it.
const [SUBSCRIPTION, API_KEY, AUTH_TOKEN, CONSOLE_PROFILE] = AUTH_CHAIN;

/** Required alongside a Claude Code OAuth token; rejected without it. */
export const OAUTH_BETA_HEADER = "oauth-2025-04-20";

const ANTHROPIC_BETA_HEADER_NAME = "anthropic-beta";
const MAX_CLIENT_RETRIES = 3;

// A recording run is 30 sessions of several calls each, unattended. The SDK
// retries 408/409/429/5xx and connection errors, honouring `retry-after`
// where the response carries one. Shared by every method: the retry policy is
// a property of the workload, not of the credential.
const SHARED_OPTIONS = { maxRetries: MAX_CLIENT_RETRIES } as const;

export function createAnthropicClient(credential: ModelCredential): Anthropic {
  switch (credential.method) {
    case SUBSCRIPTION:
      return new Anthropic({
        ...SHARED_OPTIONS,
        apiKey: null,
        authToken: credential.accessToken,
        defaultHeaders: { [ANTHROPIC_BETA_HEADER_NAME]: OAUTH_BETA_HEADER },
      });
    case API_KEY:
      return new Anthropic({ ...SHARED_OPTIONS, apiKey: credential.apiKey, authToken: null });
    case AUTH_TOKEN:
      return new Anthropic({ ...SHARED_OPTIONS, apiKey: null, authToken: credential.authToken });
    case CONSOLE_PROFILE:
      return new Anthropic({ ...SHARED_OPTIONS, profile: credential.profile });
  }
}
