// Shared fake Ports + credentials for CLI behaviour tests
// (test/behaviour/cli/{init,index,doctor,dispatch}.test.ts) — hand-written,
// no mocking framework, same rationale as fake-stdio.ts.

import { MODEL_DEFAULT } from "../../../src/core/config/constants.js";
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

export const NO_CREDENTIALS = { hasApiKey: false, hasAuthToken: false };

export function fakePorts() {
  return { model: new FixtureModelProvider({}, MODELS), clock: new FakeClock(new Date(0)), forge: new FakeForge() };
}
