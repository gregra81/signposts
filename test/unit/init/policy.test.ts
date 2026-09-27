import { describe, expect, it } from "vitest";
import {
  CLAUDE_MD_POINTER,
  ensureClaudeMdPointer,
  isConsented,
} from "../../../src/core/init/policy.js";

describe("isConsented", () => {
  it("db file present and row consented -> true", () => {
    expect(isConsented(true, true)).toBe(true);
  });

  it("db file absent -> false, even if the row would say consented", () => {
    expect(isConsented(false, true)).toBe(false);
  });

  it("db file present but row not consented -> false", () => {
    expect(isConsented(true, false)).toBe(false);
  });
});

describe("ensureClaudeMdPointer", () => {
  it("appends the pointer to an absent file", () => {
    const result = ensureClaudeMdPointer(undefined);
    expect(result.changed).toBe(true);
    expect(result.content).toBe(CLAUDE_MD_POINTER);
  });

  it("appends the pointer to an empty file", () => {
    const result = ensureClaudeMdPointer("");
    expect(result.changed).toBe(true);
    expect(result.content).toBe(CLAUDE_MD_POINTER);
  });

  it("appends after existing content, separated by a blank line", () => {
    const result = ensureClaudeMdPointer("# My Project\n\nSome docs.\n");
    expect(result.changed).toBe(true);
    expect(result.content).toBe(`# My Project\n\nSome docs.\n\n${CLAUDE_MD_POINTER}`);
  });

  it("adds a separating newline when existing content has no trailing newline", () => {
    const result = ensureClaudeMdPointer("# My Project");
    expect(result.content).toBe(`# My Project\n\n${CLAUDE_MD_POINTER}`);
  });

  it("is idempotent: already carrying the pointer is a no-op", () => {
    const already = `# My Project\n\n${CLAUDE_MD_POINTER}`;
    const result = ensureClaudeMdPointer(already);
    expect(result.changed).toBe(false);
    expect(result.content).toBe(already);
  });
});
