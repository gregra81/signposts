import { describe, expect, it } from "vitest";
import { isEligible } from "../../../src/core/eligibility/eligibility.js";
import type { Session } from "../../../src/core/eligibility/types.js";
import {
  ENDED_IDLE_HOURS,
  ENDED_MARKER_SLACK_MINUTES,
  IDLE_HOURS,
  MAX_AGE_DAYS,
} from "../../../src/core/config/constants.js";

const NOW = new Date("2026-08-09T00:00:00Z");
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Every gate holds: idle long enough, well within age, in a repo, not a
// subagent, and this contentHash hasn't been processed before.
const BASELINE: Session = {
  sessionId: "s1",
  contentHash: "hash-1",
  lastActivityAt: new Date(NOW.getTime() - (IDLE_HOURS + 1) * HOUR_MS),
  startedAt: new Date(NOW.getTime() - (MAX_AGE_DAYS - 1) * DAY_MS),
  inGitRepo: true,
  isSidechain: false,
  processedKeys: new Set(["s1:other-hash"]),
};

// One case per gate: hold every other gate's condition true, flip just
// this one gate false. Plus the all-pass baseline.
const cases: Array<[string, Session, boolean]> = [
  ["all gates pass — eligible", BASELINE, true],
  [
    "idle gate fails: last activity too recent",
    { ...BASELINE, lastActivityAt: new Date(NOW.getTime() - (IDLE_HOURS - 1) * HOUR_MS) },
    false,
  ],
  [
    "age gate fails: session older than MAX_AGE_DAYS",
    { ...BASELINE, startedAt: new Date(NOW.getTime() - (MAX_AGE_DAYS + 1) * DAY_MS) },
    false,
  ],
  [
    "idle gate boundary: last activity exactly IDLE_HOURS ago — eligible",
    { ...BASELINE, lastActivityAt: new Date(NOW.getTime() - IDLE_HOURS * HOUR_MS) },
    true,
  ],
  [
    "age gate boundary: session started exactly MAX_AGE_DAYS ago — eligible",
    { ...BASELINE, startedAt: new Date(NOW.getTime() - MAX_AGE_DAYS * DAY_MS) },
    true,
  ],
  ["git-repo gate fails: cwd not in a repo", { ...BASELINE, inGitRepo: false }, false],
  ["main-session gate fails: isSidechain true", { ...BASELINE, isSidechain: true }, false],
  [
    "not-processed gate fails: compound key already in processedKeys",
    { ...BASELINE, processedKeys: new Set(["s1:hash-1"]) },
    false,
  ],
];

// 19-value-to-a-user.md's open items: `idle_hours` and
// SIGNPOSTS_THRESHOLDS_IDLE_HOURS were accepted by the config schema and read
// by nobody — this gate used the compile-time constant, so the one override a
// person reaches for to try the tool without waiting a day did nothing.
describe("the thresholds the config carries", () => {
  it("honours a shorter idle window than the default", () => {
    const fresh = { ...BASELINE, lastActivityAt: new Date(NOW.getTime() - 2 * HOUR_MS) };

    expect(isEligible(fresh, NOW)).toBe(false);
    expect(isEligible(fresh, NOW, { idleHours: 1, maxAgeDays: MAX_AGE_DAYS })).toBe(true);
  });

  it("honours a longer one", () => {
    expect(isEligible(BASELINE, NOW, { idleHours: IDLE_HOURS + 48, maxAgeDays: MAX_AGE_DAYS })).toBe(
      false,
    );
  });

  it("honours a shorter maximum age", () => {
    expect(isEligible(BASELINE, NOW, { idleHours: IDLE_HOURS, maxAgeDays: 1 })).toBe(false);
  });

  it("falls back to the constants when given nothing, which is what every caller did", () => {
    expect(isEligible(BASELINE, NOW)).toBe(true);
  });
});

describe("isEligible", () => {
  it.each(cases)("%s", (_name, session, expected) => {
    expect(isEligible(session, NOW)).toBe(expected);
  });

  // (session_id, content_hash) is the dedup key, not session_id alone: a
  // resumed session growing new content must stay eligible, while the
  // exact same content re-seen under the same session must not.
  it("resumed-and-grown: same sessionId, new contentHash not yet processed — eligible", () => {
    const resumed: Session = {
      ...BASELINE,
      sessionId: "s1",
      contentHash: "hash-2",
      processedKeys: new Set(["s1:hash-1"]),
    };
    expect(isEligible(resumed, NOW)).toBe(true);
  });

  it("byte-identical-rerun: same sessionId, same contentHash already processed — ineligible", () => {
    const rerun: Session = {
      ...BASELINE,
      sessionId: "s1",
      contentHash: "hash-1",
      processedKeys: new Set(["s1:hash-1"]),
    };
    expect(isEligible(rerun, NOW)).toBe(false);
  });
});

// 19-value-to-a-user.md, open item 5: a session Claude Code said had ended
// waits ENDED_IDLE_HOURS, not a day — unless it was written to after the end.
describe("isEligible, for a session that ended", () => {
  const quietFor = (hours: number) => new Date(NOW.getTime() - hours * HOUR_MS);
  const MINUTE_MS = 60 * 1000;

  it("is eligible ENDED_IDLE_HOURS after it ended, a day before it otherwise would be", () => {
    const lastActivityAt = quietFor(ENDED_IDLE_HOURS);
    const quiet: Session = { ...BASELINE, lastActivityAt };

    expect(isEligible({ ...quiet, endedAt: lastActivityAt }, NOW)).toBe(true);
    expect(isEligible(quiet, NOW)).toBe(false);
  });

  it("still waits the hour", () => {
    const lastActivityAt = new Date(NOW.getTime() - ENDED_IDLE_HOURS * HOUR_MS + 1);
    expect(isEligible({ ...BASELINE, lastActivityAt, endedAt: lastActivityAt }, NOW)).toBe(false);
  });

  it("counts a marker written a little before the transcript's last line", () => {
    const lastActivityAt = quietFor(ENDED_IDLE_HOURS);
    const slack = ENDED_MARKER_SLACK_MINUTES * MINUTE_MS;

    expect(
      isEligible({ ...BASELINE, lastActivityAt, endedAt: new Date(lastActivityAt.getTime() - slack) }, NOW),
    ).toBe(true);
    expect(
      isEligible({ ...BASELINE, lastActivityAt, endedAt: new Date(lastActivityAt.getTime() - slack - 1) }, NOW),
    ).toBe(false);
  });

  it("ignores the marker once the session was resumed after it", () => {
    const endedAt = quietFor(ENDED_IDLE_HOURS + 3);
    expect(isEligible({ ...BASELINE, lastActivityAt: quietFor(ENDED_IDLE_HOURS), endedAt }, NOW)).toBe(false);
  });

  it("keeps a configured window shorter than the hour", () => {
    const lastActivityAt = quietFor(0.5);
    const thresholds = { idleHours: 0.25, maxAgeDays: MAX_AGE_DAYS };
    expect(isEligible({ ...BASELINE, lastActivityAt, endedAt: lastActivityAt }, NOW, thresholds)).toBe(true);
  });
});
