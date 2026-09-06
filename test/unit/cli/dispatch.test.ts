import { describe, expect, it } from "vitest";
import { parseCommand } from "../../../src/core/cli/dispatch.js";

const NO_OPTIONS = { isFirst: false };

describe("parseCommand", () => {
  it.each([
    [["init"], { name: "init", options: NO_OPTIONS }],
    [["index"], { name: "index", options: NO_OPTIONS }],
    [["doctor"], { name: "doctor", options: NO_OPTIONS }],
    [["sessions"], { name: "sessions", options: NO_OPTIONS }],
    [["run"], { name: "run", options: NO_OPTIONS }],
    [["resume"], { name: "resume", options: NO_OPTIONS }],
    [["init", "--extra"], { name: "init", options: NO_OPTIONS }],
    [["bogus"], { name: "unknown" }],
    [[], { name: "unknown" }],
  ] as const)("parseCommand(%j) -> %j", (argv, expected) => {
    expect(parseCommand(argv)).toEqual(expected);
  });
});

describe("the run commands' options", () => {
  it("reads --session, --replies and --first", () => {
    const parsed = parseCommand(["resume", "--session", "s-1", "--replies", "-", "--first"]);

    expect(parsed).toEqual({
      name: "resume",
      options: { sessionId: "s-1", repliesPath: "-", isFirst: true },
    });
  });

  it("ignores a flag with no value rather than reading the next flag as one", () => {
    const parsed = parseCommand(["run", "--session"]);

    expect(parsed).toEqual({ name: "run", options: NO_OPTIONS });
  });

  it("takes the value after the flag, wherever the flag sits", () => {
    const parsed = parseCommand(["run", "--first", "--session", "s-2"]);

    expect(parsed).toEqual({ name: "run", options: { sessionId: "s-2", isFirst: true } });
  });
});
