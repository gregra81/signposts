// The branch a developer's proposals land on. Per developer, per review
// cycle, and read by people — so the name has to be theirs, has to be a legal
// ref, and has to turn over once its pull request is merged.

import { describe, expect, it } from "vitest";
import { authorSlug, branchFor, branchPrefix, pickBranch } from "../../../src/core/git/branch.js";
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

const EMAIL = "greg@example.com";
const TODAY = "2026-09-08";

describe("branchFor", () => {
  it("fills the configured pattern", () => {
    expect(branchFor(BRANCH_PATTERN, EMAIL, TODAY)).toBe("signposts/greg/2026-09-08");
  });

  it("honours a pattern the user changed", () => {
    expect(branchFor("knowledge/{author_slug}/proposals", EMAIL, TODAY)).toBe(
      "knowledge/greg/proposals",
    );
  });

  it("leaves a pattern with no placeholder alone", () => {
    expect(branchFor("signposts", EMAIL, TODAY)).toBe("signposts");
  });
});

describe("branchPrefix", () => {
  it("is everything before the date", () => {
    expect(branchPrefix(BRANCH_PATTERN, EMAIL)).toBe("signposts/greg/");
  });

  it("is the whole name when the pattern has no date in it", () => {
    expect(branchPrefix("knowledge/{author_slug}", EMAIL)).toBe("knowledge/greg");
  });
});

describe("pickBranch", () => {
  const pick = (known: { branch: string; open: boolean }[], date = TODAY) =>
    pickBranch({ pattern: BRANCH_PATTERN, email: EMAIL, date, known });

  it("mints today's branch when this developer has none", () => {
    expect(pick([])).toBe("signposts/greg/2026-09-08");
  });

  it("commits onto the branch already under review, whatever day it opened", () => {
    expect(pick([{ branch: "signposts/greg/2026-09-01", open: true }])).toBe(
      "signposts/greg/2026-09-01",
    );
  });

  it("starts a new branch once the open one has been merged", () => {
    expect(pick([{ branch: "signposts/greg/2026-09-01", open: false }])).toBe(
      "signposts/greg/2026-09-08",
    );
  });

  it("suffixes the second cycle of the same day rather than reusing a merged branch", () => {
    expect(pick([{ branch: "signposts/greg/2026-09-08", open: false }])).toBe(
      "signposts/greg/2026-09-08-2",
    );
    expect(
      pick([
        { branch: "signposts/greg/2026-09-08-2", open: false },
        { branch: "signposts/greg/2026-09-08", open: false },
      ]),
    ).toBe("signposts/greg/2026-09-08-3");
  });

  it("ignores a teammate's branches", () => {
    expect(pick([{ branch: "signposts/dana/2026-09-08", open: true }])).toBe(
      "signposts/greg/2026-09-08",
    );
  });

  it("reuses the newest open branch when an older one was left open too", () => {
    expect(
      pick([
        { branch: "signposts/greg/2026-09-08", open: true },
        { branch: "signposts/greg/2026-09-01", open: true },
      ]),
    ).toBe("signposts/greg/2026-09-08");
  });

  it("still cycles a pattern that carries no date, by number instead", () => {
    const known = [{ branch: "knowledge/greg", open: false }];
    expect(pickBranch({ pattern: "knowledge/{author_slug}", email: EMAIL, date: TODAY, known })).toBe(
      "knowledge/greg-2",
    );
  });
});
