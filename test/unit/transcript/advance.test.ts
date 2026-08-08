import { describe, expect, it } from "vitest";
import { advance, createTranscriptReadState } from "../../../src/core/transcript/advance.js";

const baseEnvelope = {
  uuid: "u1",
  parentUuid: null,
  sessionId: "s1",
  timestamp: "2026-01-01T00:00:00Z",
};

const parsedLine = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({ ...baseEnvelope, type: "system", ...fields });

const ignoredLine = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "mode", mode: "normal", sessionId: "s1", ...fields });

// Table-driven: each parse status routes to its own counter.
describe("advance", () => {
  const statusCases: Array<[string, string, "linesSkipped" | "linesIgnored" | undefined]> = [
    ["malformed (bad JSON) -> linesSkipped, no emit", "{not json", "linesSkipped"],
    ["malformed (no recognisable envelope or type) -> linesSkipped, no emit", JSON.stringify({ uuid: "only-this" }), "linesSkipped"],
    ["ignored (unrecognised type) -> linesIgnored, emits", ignoredLine(), "linesIgnored"],
    ["parsed (known type) -> neither, emits", parsedLine(), undefined],
  ];

  it.each(statusCases)("%s", (_name, raw, counter) => {
    const state = createTranscriptReadState();
    const result = advance(state, raw);

    expect(state.counts.linesRead).toBe(1);
    if (counter === "linesSkipped") {
      expect(state.counts.linesSkipped).toBe(1);
      expect(state.counts.linesIgnored).toBe(0);
      expect(result).toBeUndefined();
    } else if (counter === "linesIgnored") {
      expect(state.counts.linesSkipped).toBe(0);
      expect(state.counts.linesIgnored).toBe(1);
      expect(result).toBeDefined();
    } else {
      expect(state.counts.linesSkipped).toBe(0);
      expect(state.counts.linesIgnored).toBe(0);
      expect(result).toBeDefined();
    }
  });

  it("increments linesRead on every call regardless of status", () => {
    const state = createTranscriptReadState();
    advance(state, "{not json");
    advance(state, parsedLine());
    advance(state, ignoredLine());

    expect(state.counts.linesRead).toBe(3);
  });
});
