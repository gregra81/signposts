// Fake Clock port for tests (15-spec.md "The seam": "ports.clock -> frozen").
// Hand-written, no mocking framework, matching FixtureModelProvider's style.

import type { Clock } from "../../app.ts";

export class FakeClock implements Clock {
  private current: Date;

  constructor(initial: Date) {
    this.current = initial;
  }

  now(): Date {
    return this.current;
  }
}
