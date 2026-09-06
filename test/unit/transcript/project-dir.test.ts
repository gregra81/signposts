// Claude Code's per-project transcript directory name.

import { describe, expect, it } from "vitest";
import { projectDirName } from "../../../src/core/transcript/project-dir.js";

describe("projectDirName", () => {
  it("replaces every separator with a dash", () => {
    expect(projectDirName("/Users/greg/Projects/signposts")).toBe("-Users-greg-Projects-signposts");
  });

  it.each([
    ["/Users/greg/Projects/signposts/", "-Users-greg-Projects-signposts"],
    ["/Users/greg/Projects/signposts//", "-Users-greg-Projects-signposts"],
  ])("ignores trailing separators on %j", (input, expected) => {
    expect(projectDirName(input)).toBe(expected);
  });

  it("handles a windows-shaped path", () => {
    expect(projectDirName("C:\\Users\\greg\\code")).toBe("C--Users-greg-code");
  });
});
