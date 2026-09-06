// Shared fake Ports for CLI behaviour tests
// (test/behaviour/cli/{init,index,doctor,dispatch}.test.ts) — hand-written,
// no mocking framework, same rationale as fake-stdio.ts.

import { FixtureModelProvider } from "../../../src/io/model/fixture-provider.js";
import { FakeClock } from "../../../src/io/clock/fake-clock.js";
import { FakeForge } from "../../../src/io/forge/fake-forge.js";

export function fakePorts() {
  return { model: new FixtureModelProvider({}), clock: new FakeClock(new Date(0)), forge: new FakeForge() };
}
