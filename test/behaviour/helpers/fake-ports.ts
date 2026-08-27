// Shared fake Ports + credentials for CLI behaviour tests
// (test/behaviour/cli/{init,index,doctor,dispatch}.test.ts) — hand-written,
// no mocking framework, same rationale as fake-stdio.ts.

import { AUTH_CHAIN, MODEL_DEFAULT } from "../../../src/core/config/constants.js";
import type { CredentialFact } from "../../../src/core/doctor/report.js";
import type { AuthMethod } from "../../../src/core/credentials/chain.js";
import type { NodeName } from "../../../src/core/model/types.js";
import { FixtureModelProvider } from "../../../src/io/model/fixture-provider.js";
import { FakeClock } from "../../../src/io/clock/fake-clock.js";
import { FakeForge } from "../../../src/io/forge/fake-forge.js";

export const MODELS: Record<NodeName, string> = {
  extract: MODEL_DEFAULT,
  critic: MODEL_DEFAULT,
  classify: MODEL_DEFAULT,
  resolve: MODEL_DEFAULT,
};

export const NO_CREDENTIALS: CredentialFact = {
  selected: "none",
  usable: [],
  subscriptionType: undefined,
  rateLimitTier: undefined,
  subscriptionExpired: false,
  pinned: false,
};

/** A CredentialFact for one available method — the common case in behaviour tests. */
export function credentialsFor(
  method: AuthMethod,
  overrides: Partial<CredentialFact> = {},
): CredentialFact {
  return { ...NO_CREDENTIALS, selected: method, usable: [method], ...overrides };
}

/** Named exports for the four chain members, so tests never spell them inline. */
export const [SUBSCRIPTION, API_KEY, AUTH_TOKEN, CONSOLE_PROFILE] = AUTH_CHAIN;

export function fakePorts() {
  return { model: new FixtureModelProvider({}, MODELS), clock: new FakeClock(new Date(0)), forge: new FakeForge() };
}
