// The status snapshot's shape. The file IO is src/io/worker/status-file.ts and
// is exercised in test/behaviour/worker.

import { describe, expect, it } from "vitest";
import { finishedStatus, runFinishedStatus, runningStatus } from "../../../src/core/worker/status.ts";

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
