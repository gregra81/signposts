import { describe, expect, it } from "vitest";
import { generateSlug } from "../../../src/core/signpost/slug.js";
import { ID_PATTERN, MAX_SLUG_LENGTH } from "../../../src/core/config/constants.js";

describe("generateSlug", () => {
  it("kebab-cases the claim (0 collisions)", () => {
    expect(generateSlug("The staging DB is read-only.", new Set())).toBe("the-staging-db-is-read-only");
  });

  it("collapses runs of non-alphanumeric characters to one hyphen and trims edges", () => {
    expect(generateSlug("  Foo,  Bar!! --Baz__", new Set())).toBe("foo-bar-baz");
  });

  // An id is a filename and an index table cell, and 03-memory-model.md asks
  // for "a stable slug, e.g. staging-db-read-only". Uncapped it was the whole
  // claim: a real run produced a 164-character filename.
  it("cuts a long claim to a slug, on a word boundary", () => {
    const slug = generateSlug(
      "Staging's database is read-only outside the ETL window (02:00-04:00 UTC), so migrations do not run from the deploy script there.",
      new Set(),
    );

    expect(slug).toBe("staging-s-database-is-read-only-outside-the-etl");
    expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(slug).toMatch(ID_PATTERN);
  });

  // The claim above happens to clip exactly on a hyphen, where trimming the
  // trailing separator and cutting back to the boundary agree. This one clips
  // mid-word, which is the case the boundary search is actually for.
  it("cuts back to the boundary rather than leaving half a word", () => {
    const slug = generateSlug("This repo uses pnpm and the lockfile is pnpm-lock.yaml always", new Set());

    // The clip is "…is-pnpm-loc"; the boundary search drops the half word.
    expect(slug).toBe("this-repo-uses-pnpm-and-the-lockfile-is-pnpm");
    expect(slug).toMatch(ID_PATTERN);
  });

  it("leaves a slug of exactly the cap alone", () => {
    const exact = `${"a".repeat(20)}-${"b".repeat(MAX_SLUG_LENGTH - 21)}`;
    expect(exact).toHaveLength(MAX_SLUG_LENGTH);

    // Cutting it would find the hyphen and throw away the second half.
    expect(generateSlug(exact, new Set())).toBe(exact);
  });

  it("cuts a first word longer than the cap where it falls, there being no boundary", () => {
    const slug = generateSlug(`${"a".repeat(MAX_SLUG_LENGTH + 20)} tail`, new Set());

    expect(slug).toBe("a".repeat(MAX_SLUG_LENGTH));
    expect(slug).toMatch(ID_PATTERN);
  });

  it("keeps disambiguating after the cut", () => {
    const claim = "Staging's database is read-only outside the ETL window, so migrations do not run there.";
    const first = generateSlug(claim, new Set());

    expect(generateSlug(claim, new Set([first]))).toBe(`${first}-2`);
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
