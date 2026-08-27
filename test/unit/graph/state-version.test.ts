import { describe, expect, it } from "vitest";
import { decideCheckpoint } from "../../../src/core/graph/state-version.js";
import { STATE_VERSION } from "../../../src/core/config/constants.js";

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
});
