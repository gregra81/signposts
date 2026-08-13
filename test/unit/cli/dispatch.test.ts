import { describe, expect, it } from "vitest";
import { parseCommand } from "../../../src/core/cli/dispatch.js";

describe("parseCommand", () => {
  it.each([
    [["init"], { name: "init" }],
    [["index"], { name: "index" }],
    [["doctor"], { name: "doctor" }],
    [["init", "--extra"], { name: "init" }],
    [["run"], { name: "unknown" }],
    [["bogus"], { name: "unknown" }],
    [[], { name: "unknown" }],
  ] as const)("parseCommand(%j) -> %j", (argv, expected) => {
    expect(parseCommand(argv)).toEqual(expected);
  });
});
