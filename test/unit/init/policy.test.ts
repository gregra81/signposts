import { describe, expect, it } from "vitest";
import {
  CLAUDE_MD_POINTER,
  consentExitCode,
  ensureClaudeMdPointer,
  isConsented,
  needsConsentPrompt,
  parseConsentAnswer,
} from "../../../src/core/init/policy.js";

describe("needsConsentPrompt", () => {
  it("prompts when not yet consented", () => {
    expect(needsConsentPrompt(false)).toBe(true);
  });

  it("does not prompt an already-consented repo", () => {
    expect(needsConsentPrompt(true)).toBe(false);
  });
});

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

describe("parseConsentAnswer", () => {
  it.each([
    ["y", true],
    ["Y", true],
    ["yes", true],
    ["YES", true],
    ["  yes  ", true],
    ["n", false],
    ["no", false],
    ["", false],
    ["maybe", false],
  ])("parseConsentAnswer(%j) -> %j", (raw, expected) => {
    expect(parseConsentAnswer(raw)).toBe(expected);
  });
});

describe("consentExitCode", () => {
  it("accepted -> 0", () => {
    expect(consentExitCode(true)).toBe(0);
  });

  it("declined -> 1", () => {
    expect(consentExitCode(false)).toBe(1);
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
