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

// Table-driven: each parse status routes to its own counter (R7).
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

    expect(result.state.counts.linesRead).toBe(1);
    if (counter === "linesSkipped") {
      expect(result.state.counts.linesSkipped).toBe(1);
      expect(result.state.counts.linesIgnored).toBe(0);
      expect(result.emit).toBeUndefined();
    } else if (counter === "linesIgnored") {
      expect(result.state.counts.linesSkipped).toBe(0);
      expect(result.state.counts.linesIgnored).toBe(1);
      expect(result.emit).toBeDefined();
    } else {
      expect(result.state.counts.linesSkipped).toBe(0);
      expect(result.state.counts.linesIgnored).toBe(0);
      expect(result.emit).toBeDefined();
    }
  });

  it("increments linesRead on every call regardless of status", () => {
    const state = createTranscriptReadState();
    advance(state, "{not json");
    advance(state, parsedLine());
    advance(state, ignoredLine());

    expect(state.counts.linesRead).toBe(3);
  });

  // Version recorded for both parsed and ignored lines (R4/R7).
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

  it("warns once for an unseen major, even across repeated lines with that major", () => {
    const state = createTranscriptReadState();
    const first = advance(state, parsedLine({ version: "3.0.1" }));
    const second = advance(state, parsedLine({ uuid: "u2", version: "3.0.2" }));

    expect(first.warn).toBe("transcript version major 3 is unseen (known: 2)");
    expect(second.warn).toBeUndefined();
  });

  it("never warns for a known major (2)", () => {
    const state = createTranscriptReadState();
    const result = advance(state, parsedLine({ version: "2.1.223" }));

    expect(result.warn).toBeUndefined();
  });

  it("does not warn when version is absent", () => {
    const state = createTranscriptReadState();
    const result = advance(state, parsedLine());

    expect(result.warn).toBeUndefined();
    expect(state.counts.versionsSeen.size).toBe(0);
  });

  it("does not warn when version is present but unparseable (no leading integer)", () => {
    const state = createTranscriptReadState();
    const result = advance(state, parsedLine({ version: "vNext" }));

    expect(result.warn).toBeUndefined();
    expect([...state.counts.versionsSeen]).toEqual(["vNext"]);
  });

  // otherLineSchema's `version` falls under its looseObject catchall, so a
  // non-string value must not be recorded (typeof guard, R7).
  it("does not record a non-string version on an ignored line", () => {
    const state = createTranscriptReadState();
    const result = advance(state, ignoredLine({ version: 3 }));

    expect(state.counts.versionsSeen.size).toBe(0);
    expect(result.warn).toBeUndefined();
    expect(result.emit).toBeDefined();
  });

  it("mutates and returns the same state object passed in", () => {
    const state = createTranscriptReadState();
    const result = advance(state, parsedLine());

    expect(result.state).toBe(state);
  });
});
