// The branch a developer's proposals land on. Per developer, long-lived, and
// read by people — so the name has to be theirs and has to be a legal ref.

import { describe, expect, it } from "vitest";
import { authorSlug, branchFor } from "../../../src/core/git/branch.js";
import { BRANCH_PATTERN } from "../../../src/core/config/constants.js";

describe("authorSlug", () => {
  it.each([
    ["greg@example.com", "greg"],
    ["Greg.Rashkevitch@Example.COM", "greg-rashkevitch"],
    ["greg+signposts@example.com", "greg-signposts"],
    ["  greg@example.com  ", "greg"],
    ["--greg@example.com", "greg"],
    ["greg--@example.com", "greg"],
    ["greg", "greg"],
  ])("%s -> %s", (email, expected) => {
    expect(authorSlug(email)).toBe(expected);
  });

  it.each([["@example.com"], ["   "], ["+@example.com"]])(
    "refuses %j rather than producing a nameless branch",
    (email) => {
      expect(() => authorSlug(email)).toThrow(/cannot derive a branch name/);
    },
  );
});

describe("branchFor", () => {
  it("fills the configured pattern", () => {
    expect(branchFor(BRANCH_PATTERN, "greg@example.com")).toBe("signposts/greg");
  });

  it("honours a pattern the user changed", () => {
    expect(branchFor("knowledge/{author_slug}/proposals", "greg@example.com")).toBe(
      "knowledge/greg/proposals",
    );
  });

  it("leaves a pattern with no placeholder alone", () => {
    expect(branchFor("signposts", "greg@example.com")).toBe("signposts");
  });
});
