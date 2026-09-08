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

  // Verified against a real install: `~/.claude/projects/` holds
  // `-Users-greg--buzz` for `/Users/greg/.buzz`. Matching only separators sent
  // discovery to a directory that does not exist, which surfaces as an empty
  // session list rather than as an error.
  it.each([
    ["/Users/greg/.buzz", "-Users-greg--buzz"],
    ["/Users/greg/.dotfiles/config", "-Users-greg--dotfiles-config"],
    ["/Users/greg/Projects/my_app", "-Users-greg-Projects-my-app"],
    ["/Users/greg/Projects/two words", "-Users-greg-Projects-two-words"],
  ])("replaces every other non-alphanumeric character on %j", (input, expected) => {
    expect(projectDirName(input)).toBe(expected);
  });

  it("handles a windows-shaped path", () => {
    expect(projectDirName("C:\\Users\\greg\\code")).toBe("C--Users-greg-code");
  });
});
