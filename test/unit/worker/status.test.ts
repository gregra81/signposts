// The status snapshot's shape. The file IO is src/io/worker/status-file.ts and
// is exercised in test/behaviour/worker.

import { describe, expect, it } from "vitest";
import { finishedStatus, runningStatus } from "../../../src/core/worker/status.ts";

const NOW = new Date("2026-09-09T12:00:00.000Z");

describe("runningStatus", () => {
  it("says running, with the counts not yet taken", () => {
    expect(runningStatus(NOW)).toEqual({
      phase: "running",
      updatedAt: "2026-09-09T12:00:00.000Z",
      eligibleSessions: 0,
      threadsWaiting: 0,
    });
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
  it("never writes the session watermark", () => {
    expect(finishedStatus({ now: NOW, eligibleSessions: 5, threadsWaiting: 0 })).not.toHaveProperty(
      "lastRunFinishedAt",
    );
  });
});
