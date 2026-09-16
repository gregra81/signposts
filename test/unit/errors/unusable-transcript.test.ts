import { describe, expect, it } from "vitest";
import { UnusableTranscriptError } from "../../../src/core/errors/unusable-transcript.js";

describe("UnusableTranscriptError", () => {
  it("is an Error the run loop can tell apart by type and by name", () => {
    const error = new UnusableTranscriptError("/t/s.jsonl: no usable transcript lines");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("UnusableTranscriptError");
    expect(error.message).toBe("/t/s.jsonl: no usable transcript lines");
  });
});
