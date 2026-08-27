// Production Clock port (15-spec.md D1) — wraps the real wall clock.

import type { Clock } from "../../app.ts";

export const systemClock: Clock = {
  now: () => new Date(),
};
