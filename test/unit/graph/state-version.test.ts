import { describe, expect, it } from "vitest";
import { decideCheckpoint } from "../../../src/core/graph/state-version.js";
import { STATE_VERSION, THREAD_EXPIRY_DAYS } from "../../../src/core/config/constants.js";

const MS_PER_DAY = 86_400_000;
const NOW = new Date("2026-08-30T00:00:00.000Z");

/** A checkpoint timestamp `days` before NOW. */
function writtenDaysAgo(days: number): string {
  return new Date(NOW.getTime() - days * MS_PER_DAY).toISOString();
}

describe("decideCheckpoint", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
  ])("starts fresh when the thread has no checkpoint (%s)", (_name, loaded) => {
    expect(decideCheckpoint(loaded)).toEqual({ action: "start-fresh" });
  });

  it("resumes a checkpoint carrying the current version", () => {
    expect(decideCheckpoint({ version: STATE_VERSION, repo: "acme/api" })).toEqual({
      action: "resume",
    });
  });

  it("discards a checkpoint written by an older shape", () => {
    expect(decideCheckpoint({ version: STATE_VERSION - 1 })).toEqual({
      action: "discard",
      foundVersion: STATE_VERSION - 1,
    });
  });

  it("discards a checkpoint written by a newer shape", () => {
    expect(decideCheckpoint({ version: STATE_VERSION + 1 })).toEqual({
      action: "discard",
      foundVersion: STATE_VERSION + 1,
    });
  });

  it("discards a checkpoint with no version field at all", () => {
    expect(decideCheckpoint({ repo: "acme/api" })).toEqual({
      action: "discard",
      foundVersion: undefined,
    });
  });

  it.each([
    ["a string", "1"],
    ["a number", 1],
    ["a boolean", true],
  ])("discards a non-object payload (%s)", (_name, loaded) => {
    expect(decideCheckpoint(loaded)).toEqual({ action: "discard", foundVersion: undefined });
  });

  // A version that only LOOKS right. String "1" is not number 1, and treating
  // it as recognised is exactly the silent resume the version field prevents.
  it("discards a version of the wrong type", () => {
    expect(decideCheckpoint({ version: String(STATE_VERSION) })).toEqual({
      action: "discard",
      foundVersion: String(STATE_VERSION),
    });
  });

  // Only channels a node actually wrote appear in a checkpoint, so a healthy
  // half-finished thread is sparse. It must still resume.
  it("resumes a sparse checkpoint that carries only the version", () => {
    expect(decideCheckpoint({ version: STATE_VERSION })).toEqual({ action: "resume" });
  });

  // 15-spec.md: "A thread older than the expiry is dropped with a log line."
  // The partition a stale thread halted on was computed against neighbours,
  // ids and a bootstrap flag the repo has moved past.
  it("expires a readable checkpoint older than the expiry", () => {
    expect(
      decideCheckpoint(
        { version: STATE_VERSION },
        { checkpointedAt: writtenDaysAgo(THREAD_EXPIRY_DAYS + 1), now: NOW },
      ),
    ).toEqual({ action: "expired", ageDays: THREAD_EXPIRY_DAYS + 1 });
  });

  it("resumes a checkpoint written exactly at the expiry", () => {
    expect(
      decideCheckpoint(
        { version: STATE_VERSION },
        { checkpointedAt: writtenDaysAgo(THREAD_EXPIRY_DAYS), now: NOW },
      ),
    ).toEqual({ action: "resume" });
  });

  it("resumes a checkpoint written within the expiry", () => {
    expect(
      decideCheckpoint({ version: STATE_VERSION }, { checkpointedAt: writtenDaysAgo(3), now: NOW }),
    ).toEqual({ action: "resume" });
  });

  // The version decides whether the payload means anything at all, so it is
  // read first: an unreadable checkpoint is a discard however old it is.
  it("discards an unrecognised version even when it is also expired", () => {
    expect(
      decideCheckpoint(
        { version: STATE_VERSION + 1 },
        { checkpointedAt: writtenDaysAgo(THREAD_EXPIRY_DAYS + 1), now: NOW },
      ),
    ).toEqual({ action: "discard", foundVersion: STATE_VERSION + 1 });
  });

  // An age nobody can compute is not evidence of staleness.
  it.each([
    ["absent", undefined],
    ["unparseable", "three days ago"],
  ])("resumes when the timestamp is %s", (_name, checkpointedAt) => {
    expect(decideCheckpoint({ version: STATE_VERSION }, { checkpointedAt, now: NOW })).toEqual({
      action: "resume",
    });
  });

  it("skips the age check entirely when no age is passed", () => {
    expect(decideCheckpoint({ version: STATE_VERSION })).toEqual({ action: "resume" });
  });
});
