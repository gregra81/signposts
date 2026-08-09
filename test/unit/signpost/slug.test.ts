import { describe, expect, it } from "vitest";
import { generateSlug } from "../../../src/core/signpost/slug.js";
import { ID_PATTERN } from "../../../src/core/config/constants.js";

describe("generateSlug", () => {
  it("kebab-cases the claim (0 collisions)", () => {
    expect(generateSlug("The staging DB is read-only.", new Set())).toBe("the-staging-db-is-read-only");
  });

  it("collapses runs of non-alphanumeric characters to one hyphen and trims edges", () => {
    expect(generateSlug("  Foo,  Bar!! --Baz__", new Set())).toBe("foo-bar-baz");
  });

  it("falls back to a fixed slug when the claim has no alphanumeric characters", () => {
    expect(generateSlug("!!!", new Set())).toBe("signpost");
  });

  it("appends -2 on a single collision", () => {
    expect(generateSlug("Foo bar", new Set(["foo-bar"]))).toBe("foo-bar-2");
  });

  it("appends -3 when -2 is also taken (2+ collisions)", () => {
    expect(generateSlug("Foo bar", new Set(["foo-bar", "foo-bar-2"]))).toBe("foo-bar-3");
  });

  it("skips past a gap in existing numeric suffixes", () => {
    expect(generateSlug("Foo bar", new Set(["foo-bar", "foo-bar-2", "foo-bar-3", "foo-bar-4"]))).toBe("foo-bar-5");
  });

  it("does not collide with an unrelated id that merely starts with the same prefix", () => {
    expect(generateSlug("Foo bar", new Set(["foo-bar-baz"]))).toBe("foo-bar");
  });

  it.each([
    ["The staging DB is read-only.", new Set<string>()],
    ["!!!", new Set<string>()],
    ["Foo bar", new Set(["foo-bar"])],
    ["Foo bar", new Set(["foo-bar", "foo-bar-2"])],
  ] as const)("output always matches ID_PATTERN: %j", (claim, existing) => {
    expect(generateSlug(claim, existing)).toMatch(ID_PATTERN);
  });
});
