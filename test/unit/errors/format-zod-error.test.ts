import { describe, expect, it } from "vitest";
import { z } from "zod";
import { formatZodError, summariseIssues } from "../../../src/core/errors/format-zod-error.js";

describe("formatZodError", () => {
  it("formats a single issue as one path: message line", () => {
    const schema = z.object({ k: z.number() });
    const result = schema.safeParse({ k: "not-a-number" });
    expect(result.success).toBe(false);
    if (result.success) return;

    expect(formatZodError(result.error)).toBe("k: Invalid input: expected number, received string");
  });

  it("joins multiple issues on separate lines, one per issue", () => {
    const schema = z.object({ k: z.number(), name: z.string() });
    const result = schema.safeParse({ k: "not-a-number", name: 1 });
    expect(result.success).toBe(false);
    if (result.success) return;

    const message = formatZodError(result.error);
    expect(message).toMatch(/^k: .+\nname: .+$/s);
  });

  it("joins a nested path with dots", () => {
    const schema = z.object({ git: z.object({ branch_pattern: z.string() }) });
    const result = schema.safeParse({ git: { branch_pattern: 1 } });
    expect(result.success).toBe(false);
    if (result.success) return;

    expect(formatZodError(result.error)).toMatch(/^git\.branch_pattern: .+$/);
  });
});

describe("summariseIssues", () => {
  const issue = (path: PropertyKey[], message: string) => ({ path, message });

  it("renders one issue as path and message", () => {
    expect(summariseIssues([issue(["claim"], "too long")])).toBe("claim: too long");
  });

  it("joins a nested path with dots", () => {
    expect(summariseIssues([issue(["candidates", 0, "claim"], "too long")])).toBe(
      "candidates.0.claim: too long",
    );
  });

  // A root-level issue has an empty path, which would render as a bare
  // ": message" and say nothing about which value was wrong.
  it("labels an empty path (root)", () => {
    expect(summariseIssues([issue([], "expected object")])).toBe("(root): expected object");
  });

  it("separates several issues with a semicolon", () => {
    expect(summariseIssues([issue(["a"], "bad"), issue(["b"], "worse")])).toBe(
      "a: bad; b: worse",
    );
  });

  it("is empty for no issues", () => {
    expect(summariseIssues([])).toBe("");
  });
});
