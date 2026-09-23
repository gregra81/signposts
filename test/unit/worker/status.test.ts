// The status snapshot's shape. The file IO is src/io/worker/status-file.ts and
// is exercised in test/behaviour/worker.

import { describe, expect, it } from "vitest";
import {
  finishedStatus,
  progressIsLive,
  runFinishedStatus,
  runningStatus,
  runProgressStatus,
  unpublishedStatus,
} from "../../../src/core/worker/status.ts";

const NOW = new Date("2026-09-09T12:00:00.000Z");
/** A session's last activity — always older than the run that judged it. */
const FINISHED_THROUGH = new Date("2026-09-09T11:30:00.000Z");
const WATERMARK = "2026-09-09T11:30:00.000Z";

describe("runningStatus", () => {
  it("says running, with the counts not yet taken", () => {
    expect(runningStatus(NOW)).toEqual({
      phase: "running",
      updatedAt: "2026-09-09T12:00:00.000Z",
      eligibleSessions: 0,
      threadsWaiting: 0,
    });
  });

  it("keeps the watermark it was handed, so a reindex does not erase it", () => {
    expect(runningStatus(NOW, WATERMARK).lastRunFinishedAt).toBe(WATERMARK);
  });

  it("omits it when there is none", () => {
    expect(runningStatus(NOW)).not.toHaveProperty("lastRunFinishedAt");
  });
});

describe("finishedStatus", () => {
  it("records the census and the time", () => {
    expect(finishedStatus({ now: NOW, eligibleSessions: 3, threadsWaiting: 2 })).toEqual({
      phase: "idle",
      updatedAt: "2026-09-09T12:00:00.000Z",
      eligibleSessions: 3,
      threadsWaiting: 2,
    });
  });

  it("omits lastIndexedAt when the index was already current", () => {
    expect(finishedStatus({ now: NOW, eligibleSessions: 0, threadsWaiting: 0 })).not.toHaveProperty(
      "lastIndexedAt",
    );
  });

  it("records lastIndexedAt when it rebuilt", () => {
    const status = finishedStatus({
      now: NOW,
      eligibleSessions: 0,
      threadsWaiting: 0,
      indexedAt: new Date("2026-09-09T11:59:00.000Z"),
    });
    expect(status.lastIndexedAt).toBe("2026-09-09T11:59:00.000Z");
  });

  // A detached worker's stderr goes to /dev/null, so this field is the only
  // place a failure is ever visible.
  it("carries the error when there was one, and omits it otherwise", () => {
    expect(
      finishedStatus({ now: NOW, eligibleSessions: 0, threadsWaiting: 0, error: "no origin remote" })
        .lastError,
    ).toBe("no origin remote");
    expect(finishedStatus({ now: NOW, eligibleSessions: 0, threadsWaiting: 0 })).not.toHaveProperty(
      "lastError",
    );
  });

  it.each([
    [-1, 0],
    [Number.NaN, 0],
    [2.7, 2],
  ])("normalises a count of %s to %s", (given, expected) => {
    expect(finishedStatus({ now: NOW, eligibleSessions: given, threadsWaiting: given })).toMatchObject({
      eligibleSessions: expected,
      threadsWaiting: expected,
    });
  });

  // The watermark the hook uses to stop waking for a session it has already
  // seen. The worker processes no sessions, so writing it here would silence
  // the hook about a backlog nobody has touched.
  it("never mints the session watermark", () => {
    expect(finishedStatus({ now: NOW, eligibleSessions: 5, threadsWaiting: 0 })).not.toHaveProperty(
      "lastRunFinishedAt",
    );
  });

  // ...but a snapshot that dropped the one `settle` wrote would silence
  // nothing and re-announce everything, which is the bug this pair exists to
  // stop: two processes, one file, neither erasing the other's half.
  it("carries a watermark it was handed straight back", () => {
    expect(
      finishedStatus({
        now: NOW,
        eligibleSessions: 5,
        threadsWaiting: 0,
        lastRunFinishedAt: WATERMARK,
      }).lastRunFinishedAt,
    ).toBe(WATERMARK);
  });
});

describe("runFinishedStatus", () => {
  const CENSUS = finishedStatus({ now: NOW, eligibleSessions: 4, threadsWaiting: 2 });

  it("stamps the watermark at the activity it finished through, not at the clock", () => {
    expect(runFinishedStatus(CENSUS, FINISHED_THROUGH).lastRunFinishedAt).toBe(WATERMARK);
  });

  // The counts belong to the worker's census and this path counts nothing, so
  // it must not overwrite them — nor `updatedAt`, which dates them.
  it("leaves the worker's half of the file alone", () => {
    expect(runFinishedStatus(CENSUS, FINISHED_THROUGH)).toMatchObject({
      phase: "idle",
      updatedAt: NOW.toISOString(),
      eligibleSessions: 4,
      threadsWaiting: 2,
    });
  });

  it("moves a watermark that was already there", () => {
    const earlier = runFinishedStatus(CENSUS, new Date("2026-09-01T08:00:00.000Z"));

    expect(runFinishedStatus(earlier, FINISHED_THROUGH).lastRunFinishedAt).toBe(WATERMARK);
  });

  // The first run in a repo the worker has never woken in: there is no census
  // to preserve, and the watermark still has to land.
  it("writes a whole snapshot when there is no previous one", () => {
    expect(runFinishedStatus(undefined, FINISHED_THROUGH)).toEqual({
      phase: "idle",
      updatedAt: WATERMARK,
      eligibleSessions: 0,
      threadsWaiting: 0,
      lastRunFinishedAt: WATERMARK,
    });
  });
});

// A run halted on a review can sit for days, and a reindex is free to happen
// around it. Both of the worker's writes replace the file whole, so a run the
// statusLine is rendering has to survive them — exactly as the watermark does.
describe("the worker carries a run's progress across its own writes", () => {
  const PROGRESS = {
    sessionsDone: 1,
    sessionsTotal: 3,
    found: 2,
    updatedAt: "2026-09-09T11:59:00.000Z",
  };

  it("keeps it while the worker is reindexing", () => {
    expect(runningStatus(NOW, undefined, PROGRESS).runProgress).toEqual(PROGRESS);
  });

  it("omits it when there is no run in flight", () => {
    expect(runningStatus(NOW, WATERMARK)).not.toHaveProperty("runProgress");
  });

  it("keeps it when the worker exits", () => {
    const status = finishedStatus({
      now: NOW,
      eligibleSessions: 0,
      threadsWaiting: 0,
      runProgress: PROGRESS,
    });

    expect(status.runProgress).toEqual(PROGRESS);
  });

  it("omits it from a census taken between runs", () => {
    expect(
      finishedStatus({ now: NOW, eligibleSessions: 0, threadsWaiting: 0 }),
    ).not.toHaveProperty("runProgress");
  });
});

describe("runFinishedStatus and the run's progress", () => {
  // The watermark moves only when nothing eligible is left, which is the same
  // moment the run stops being in flight. Left behind, the progress would sit
  // on the bar reading "3/3" until it aged out.
  it("drops the progress with the same write", () => {
    const previous = {
      phase: "idle" as const,
      updatedAt: "2026-09-09T11:59:00.000Z",
      eligibleSessions: 0,
      threadsWaiting: 0,
      runProgress: {
        sessionsDone: 3,
        sessionsTotal: 3,
        found: 5,
        updatedAt: "2026-09-09T11:59:00.000Z",
      },
    };

    expect(runFinishedStatus(previous, FINISHED_THROUGH)).not.toHaveProperty("runProgress");
  });
});

describe("runProgressStatus", () => {
  const live = (updatedAt: string) => ({
    phase: "idle" as const,
    updatedAt,
    eligibleSessions: 0,
    threadsWaiting: 0,
    runProgress: { sessionsDone: 1, sessionsTotal: 3, found: 2, updatedAt },
  });

  it("starts a run at zero done, with what is left as the denominator", () => {
    const status = runProgressStatus(undefined, {
      now: NOW,
      remaining: 3,
      sessionFinished: false,
      found: 0,
      threadsWaiting: 0,
      freshRun: false,
    });

    expect(status.runProgress).toEqual({
      sessionsDone: 0,
      sessionsTotal: 3,
      found: 0,
      updatedAt: "2026-09-09T12:00:00.000Z",
    });
  });

  it("counts a finished session and adds what it proposed", () => {
    const status = runProgressStatus(live("2026-09-09T11:59:00.000Z"), {
      now: NOW,
      remaining: 1,
      sessionFinished: true,
      found: 4, threadsWaiting: 0, freshRun: false }
    );

    expect(status.runProgress).toEqual({
      sessionsDone: 2,
      sessionsTotal: 3,
      found: 6,
      updatedAt: "2026-09-09T12:00:00.000Z",
    });
  });

  // A halt is not progress, but it is proof the run is alive — so the stamp
  // moves and nothing else does. Counting `found` here would count the same
  // proposals again on every resume of the same session.
  it("moves only the clock when the session halted", () => {
    const status = runProgressStatus(live("2026-09-09T11:59:00.000Z"), {
      now: NOW,
      remaining: 2,
      sessionFinished: false,
      found: 9, threadsWaiting: 0, freshRun: false }
    );

    expect(status.runProgress).toEqual({
      sessionsDone: 1,
      sessionsTotal: 3,
      found: 2,
      updatedAt: "2026-09-09T12:00:00.000Z",
    });
  });

  // RUN_PROGRESS_STALE_MINUTES: a run abandoned last week must not have its
  // count adopted by this one.
  it("starts fresh when the progress it found had aged out", () => {
    const status = runProgressStatus(live("2026-09-01T00:00:00.000Z"), {
      now: NOW,
      remaining: 2,
      sessionFinished: true,
      found: 1, threadsWaiting: 0, freshRun: false }
    );

    expect(status.runProgress).toEqual({
      sessionsDone: 1,
      sessionsTotal: 3,
      found: 1,
      updatedAt: "2026-09-09T12:00:00.000Z",
    });
  });

  // Changed contract. `threadsWaiting` used to be the worker's alone and was
  // carried through here; a run now retakes the census from the same source
  // the worker uses, because the worker runs only at session start and a
  // review parked mid-run was invisible until the next one.
  it("retakes the census, and carries the worker's own fields through", () => {
    const previous = {
      ...live("2026-09-09T11:59:00.000Z"),
      eligibleSessions: 4,
      threadsWaiting: 1,
      lastIndexedAt: "2026-09-09T10:00:00.000Z",
      lastError: "index rebuild exited 1",
      lastRunFinishedAt: WATERMARK,
    };
    const status = runProgressStatus(previous, {
      now: NOW,
      remaining: 0,
      sessionFinished: true,
      found: 0, threadsWaiting: 0, freshRun: false }
    );

    expect(status.eligibleSessions).toBe(0);
    expect(status.threadsWaiting).toBe(0);
    // Only the worker can know these two, so they survive untouched.
    expect(status.lastIndexedAt).toBe("2026-09-09T10:00:00.000Z");
    expect(status.lastError).toBe("index rebuild exited 1");
    expect(status.lastRunFinishedAt).toBe(WATERMARK);
  });

  // The age guard is a proxy for "a different run"; `--first` is the signal
  // itself. A run abandoned five minutes ago is well inside the window, and
  // its two sessions must not be adopted by the run that replaces it.
  it("starts fresh when --first says this session opens a run", () => {
    const status = runProgressStatus(live("2026-09-09T11:59:00.000Z"), {
      now: NOW,
      remaining: 2,
      sessionFinished: true,
      found: 1,
      threadsWaiting: 0,
      freshRun: true,
    });

    expect(status.runProgress).toEqual({
      sessionsDone: 1,
      sessionsTotal: 3,
      found: 1,
      updatedAt: "2026-09-09T12:00:00.000Z",
    });
  });

  // `updatedAt` dates the snapshot, and this path retakes both counts on it.
  it("re-stamps the snapshot it is retaking the census on", () => {
    const status = runProgressStatus(live("2026-09-09T11:59:00.000Z"), {
      now: NOW,
      remaining: 1,
      sessionFinished: false,
      found: 0,
      threadsWaiting: 0,
      freshRun: false,
    });

    expect(status.updatedAt).toBe("2026-09-09T12:00:00.000Z");
  });

  it("refuses counts that are not whole and not positive", () => {
    const status = runProgressStatus(undefined, {
      now: NOW,
      remaining: -3,
      sessionFinished: true,
      found: 2.7,
      threadsWaiting: 0,
      freshRun: false,
    });

    expect(status.runProgress).toEqual({
      sessionsDone: 1,
      sessionsTotal: 1,
      found: 2,
      updatedAt: "2026-09-09T12:00:00.000Z",
    });
  });
});

describe("progressIsLive", () => {
  const progress = (updatedAt: string) => ({
    sessionsDone: 1,
    sessionsTotal: 2,
    found: 0,
    updatedAt,
  });

  it("is false with no progress at all", () => {
    expect(progressIsLive(undefined, NOW)).toBe(false);
  });

  it("is true just inside the window", () => {
    expect(progressIsLive(progress("2026-09-09T11:46:00.000Z"), NOW)).toBe(true);
  });

  it("is false at the window's edge", () => {
    expect(progressIsLive(progress("2026-09-09T11:45:00.000Z"), NOW)).toBe(false);
  });

  it("is false for a stamp that does not parse", () => {
    expect(progressIsLive(progress("last tuesday"), NOW)).toBe(false);
  });
});

// 19-value-to-a-user.md item 2: what the hook reads to stop counting a session
// a run has judged, before the watermark can move.
describe("judgedSessions", () => {
  const judging = (sessionId: string, lastActivityAt: Date) => ({
    now: NOW,
    remaining: 1,
    sessionFinished: true,
    found: 0,
    threadsWaiting: 0,
    freshRun: false,
    judged: { sessionId, lastActivityAt },
  });

  it("records the judged session at its own last activity", () => {
    const status = runProgressStatus(undefined, judging("sess-a", FINISHED_THROUGH));
    expect(status.judgedSessions).toEqual({ "sess-a": FINISHED_THROUGH.toISOString() });
  });

  it("adds to what earlier invocations of the run recorded", () => {
    const first = runProgressStatus(undefined, judging("sess-a", FINISHED_THROUGH));
    const later = new Date(FINISHED_THROUGH.getTime() + 1000);
    const second = runProgressStatus(first, judging("sess-b", later));

    expect(second.judgedSessions).toEqual({
      "sess-a": FINISHED_THROUGH.toISOString(),
      "sess-b": later.toISOString(),
    });
  });

  it("keeps them, and adds nothing, while a session is halted", () => {
    const first = runProgressStatus(undefined, judging("sess-a", FINISHED_THROUGH));
    const { judged: _none, ...halted } = judging("unused", NOW);
    const status = runProgressStatus(first, { ...halted, sessionFinished: false });

    expect(status.judgedSessions).toEqual({ "sess-a": FINISHED_THROUGH.toISOString() });
  });

  it("omits the map rather than writing an empty one", () => {
    const { judged: _none, ...halted } = judging("unused", NOW);
    expect(runProgressStatus(undefined, halted)).not.toHaveProperty("judgedSessions");
  });

  it("forgets what the watermark already covers", () => {
    const previous = {
      phase: "idle" as const,
      updatedAt: WATERMARK,
      eligibleSessions: 0,
      threadsWaiting: 0,
      lastRunFinishedAt: WATERMARK,
      judgedSessions: { "at-watermark": WATERMARK, "before-watermark": "2026-09-09T11:00:00.000Z" },
    };
    const later = new Date("2026-09-09T11:45:00.000Z");

    expect(runProgressStatus(previous, judging("after", later)).judgedSessions).toEqual({
      after: later.toISOString(),
    });
  });

  it("forgets what is too old for the hook to count", () => {
    // MAX_AGE_DAYS is 90: a transcript that old is out of the hook's window
    // whatever the map says, so remembering it only grows the file.
    const old = new Date(NOW.getTime() - 91 * 86_400_000);
    const recent = new Date(NOW.getTime() - 89 * 86_400_000);
    const withOld = runProgressStatus(undefined, judging("old", old));
    expect(withOld).not.toHaveProperty("judgedSessions");

    expect(runProgressStatus(undefined, judging("recent", recent)).judgedSessions).toEqual({
      recent: recent.toISOString(),
    });
  });

  it("is trimmed to what is after the watermark when the watermark moves", () => {
    const previous = {
      phase: "idle" as const,
      updatedAt: WATERMARK,
      eligibleSessions: 0,
      threadsWaiting: 0,
      judgedSessions: {
        covered: FINISHED_THROUGH.toISOString(),
        newer: "2026-09-09T11:45:00.000Z",
      },
    };

    expect(runFinishedStatus(previous, FINISHED_THROUGH).judgedSessions).toEqual({
      newer: "2026-09-09T11:45:00.000Z",
    });
  });

  it("is dropped entirely when the watermark covers all of it", () => {
    const previous = {
      phase: "idle" as const,
      updatedAt: WATERMARK,
      eligibleSessions: 0,
      threadsWaiting: 0,
      judgedSessions: { covered: FINISHED_THROUGH.toISOString() },
    };

    expect(runFinishedStatus(previous, FINISHED_THROUGH)).not.toHaveProperty("judgedSessions");
  });

  it("is carried through both of the worker's writes", () => {
    const judged = { "sess-a": WATERMARK };
    expect(runningStatus(NOW, undefined, undefined, judged).judgedSessions).toEqual(judged);
    expect(
      finishedStatus({ now: NOW, eligibleSessions: 0, threadsWaiting: 0, judgedSessions: judged }).judgedSessions,
    ).toEqual(judged);
    expect(runningStatus(NOW)).not.toHaveProperty("judgedSessions");
    expect(finishedStatus({ now: NOW, eligibleSessions: 0, threadsWaiting: 0 })).not.toHaveProperty("judgedSessions");
  });
});

// 19-value-to-a-user.md item 3: the soonest a parked review expires, for the
// status line and the hook to warn before it goes.
describe("reviewExpiresAt", () => {
  const EXPIRES = new Date("2026-09-12T12:00:00.000Z");

  it("is written with the census the run takes", () => {
    const status = runProgressStatus(undefined, {
      now: NOW,
      remaining: 0,
      sessionFinished: false,
      found: 0,
      threadsWaiting: 1,
      freshRun: false,
      reviewExpiresAt: EXPIRES,
    });
    expect(status.reviewExpiresAt).toBe(EXPIRES.toISOString());
  });

  it("is retaken rather than carried: no review waiting, no expiry", () => {
    const previous = runProgressStatus(undefined, {
      now: NOW, remaining: 0, sessionFinished: false, found: 0, threadsWaiting: 1, freshRun: false, reviewExpiresAt: EXPIRES,
    });
    const answered = runProgressStatus(previous, {
      now: NOW, remaining: 0, sessionFinished: true, found: 0, threadsWaiting: 0, freshRun: false,
    });
    expect(answered).not.toHaveProperty("reviewExpiresAt");
  });

  it("is written with the census the worker takes", () => {
    expect(
      finishedStatus({ now: NOW, eligibleSessions: 0, threadsWaiting: 1, reviewExpiresAt: EXPIRES }).reviewExpiresAt,
    ).toBe(EXPIRES.toISOString());
    expect(finishedStatus({ now: NOW, eligibleSessions: 0, threadsWaiting: 0 })).not.toHaveProperty("reviewExpiresAt");
  });
});

// 19-value-to-a-user.md, open item 14: how many sessions sit committed and
// unpushed, for the status line's reminder.
describe("unpublishedStatus", () => {
  const previous = finishedStatus({ now: NOW, eligibleSessions: 2, threadsWaiting: 1, lastRunFinishedAt: WATERMARK });

  it("sets the count and leaves the rest of the file alone", () => {
    expect(unpublishedStatus(previous, 2, NOW)).toEqual({ ...previous, unpublishedSessions: 2 });
  });

  it("drops the field at zero, so a published branch leaves nothing behind", () => {
    expect(unpublishedStatus({ ...previous, unpublishedSessions: 3 }, 0, NOW)).toEqual(previous);
  });

  it("refuses a count that is not whole and not positive", () => {
    expect(unpublishedStatus(previous, -1, NOW)).toEqual(previous);
    expect(unpublishedStatus(previous, 1.7, NOW)).toEqual({ ...previous, unpublishedSessions: 1 });
  });

  it("writes a whole snapshot when there is no previous one", () => {
    expect(unpublishedStatus(undefined, 1, NOW)).toEqual({
      phase: "idle",
      updatedAt: NOW.toISOString(),
      eligibleSessions: 0,
      threadsWaiting: 0,
      unpublishedSessions: 1,
    });
  });

  it("is carried through both of the worker's writes", () => {
    expect(runningStatus(NOW, undefined, undefined, undefined, 2).unpublishedSessions).toBe(2);
    expect(finishedStatus({ now: NOW, eligibleSessions: 0, threadsWaiting: 0, unpublishedSessions: 2 }).unpublishedSessions).toBe(2);
    expect(runningStatus(NOW)).not.toHaveProperty("unpublishedSessions");
  });
});
