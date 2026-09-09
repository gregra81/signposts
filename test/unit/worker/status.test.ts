// The status snapshot's shape. The file IO is src/io/worker/status-file.ts and
// is exercised in test/behaviour/worker.

import { describe, expect, it } from "vitest";
import {
  finishedStatus,
  progressIsLive,
  runFinishedStatus,
  runningStatus,
  runProgressStatus,
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
    expect(runProgressStatus(undefined, { now: NOW, remaining: 3, sessionFinished: false, found: 0 })
      .runProgress).toEqual({
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
      found: 4,
    });

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
      found: 9,
    });

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
      found: 1,
    });

    expect(status.runProgress).toEqual({
      sessionsDone: 1,
      sessionsTotal: 3,
      found: 1,
      updatedAt: "2026-09-09T12:00:00.000Z",
    });
  });

  it("leaves the census and the watermark where they were", () => {
    const previous = {
      ...live("2026-09-09T11:59:00.000Z"),
      eligibleSessions: 4,
      threadsWaiting: 1,
      lastRunFinishedAt: WATERMARK,
    };
    const status = runProgressStatus(previous, {
      now: NOW,
      remaining: 0,
      sessionFinished: true,
      found: 0,
    });

    expect(status.eligibleSessions).toBe(4);
    expect(status.threadsWaiting).toBe(1);
    expect(status.lastRunFinishedAt).toBe(WATERMARK);
  });

  it("refuses counts that are not whole and not positive", () => {
    const status = runProgressStatus(undefined, {
      now: NOW,
      remaining: -3,
      sessionFinished: true,
      found: 2.7,
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
