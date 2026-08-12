import { describe, expect, it } from "vitest";
import { normalize } from "../../../src/core/retrieval/normalize.js";

describe("normalize", () => {
  const cases: Array<{ name: string; input: string; expected: string }> = [
    { name: "mixed case", input: "The Staging DB Is Read-Only", expected: "the staging db is read-only" },
    { name: "multiple internal spaces", input: "a   b    c", expected: "a b c" },
    { name: "tabs and newlines collapse too", input: "a\tb\n\nc", expected: "a b c" },
    { name: "trailing exclamation", input: "run migrations against dev instead!", expected: "run migrations against dev instead" },
    { name: "trailing ellipsis", input: "never run migrations against staging...", expected: "never run migrations against staging" },
    { name: "leading and trailing whitespace", input: "   spaced out   ", expected: "spaced out" },
    { name: "trailing punctuation run mixed with spaces", input: "done now !  ", expected: "done now" },
    {
      name: "combination: case, whitespace, punctuation",
      input: "  Staging DB   Is Read-Only!!!  ",
      expected: "staging db is read-only",
    },
    { name: "no trailing punctuation, nothing stripped", input: "already normal", expected: "already normal" },
    { name: "empty string", input: "", expected: "" },
    { name: "punctuation only", input: "...", expected: "" },
  ];

  it.each(cases)("$name", ({ input, expected }) => {
    expect(normalize(input)).toBe(expected);
  });
});
