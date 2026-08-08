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

  // Version recorded for both parsed and ignored lines.
  it("records the version from a parsed line", () => {
    const state = createTranscriptReadState();
    advance(state, parsedLine({ version: "2.1.223" }));

    expect([...state.counts.versionsSeen]).toEqual(["2.1.223"]);
  });

  it("records the version from an ignored line", () => {
    const state = createTranscriptReadState();
    advance(state, ignoredLine({ version: "3.0.1" }));

    expect([...state.counts.versionsSeen]).toEqual(["3.0.1"]);
  });

  it("does not record a version when absent", () => {
    const state = createTranscriptReadState();
    advance(state, parsedLine());

    expect(state.counts.versionsSeen.size).toBe(0);
  });

  it("records a version string as-is even when it has no leading integer", () => {
    const state = createTranscriptReadState();
    advance(state, parsedLine({ version: "vNext" }));

    expect([...state.counts.versionsSeen]).toEqual(["vNext"]);
  });

  // otherLineSchema's `version` falls under its looseObject catchall, so a
  // non-string value must not be recorded (typeof guard).
  it("does not record a non-string version on an ignored line", () => {
    const state = createTranscriptReadState();
    const result = advance(state, ignoredLine({ version: 3 }));

    expect(state.counts.versionsSeen.size).toBe(0);
    expect(result).toBeDefined();
  });
});
