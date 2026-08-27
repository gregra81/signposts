import { describe, expect, it } from "vitest";
import { deriveOwnerRepo } from "../../../src/core/git/owner-repo.js";

describe("deriveOwnerRepo", () => {
  it("parses an SSH remote", () => {
    expect(deriveOwnerRepo("git@github.com:owner/name.git")).toBe("owner/name");
  });

  it("parses an SSH remote without a .git suffix", () => {
    expect(deriveOwnerRepo("git@github.com:owner/name")).toBe("owner/name");
  });

  it("parses an HTTPS remote", () => {
    expect(deriveOwnerRepo("https://github.com/owner/name.git")).toBe("owner/name");
  });

  it("parses an HTTPS remote without a .git suffix", () => {
    expect(deriveOwnerRepo("https://github.com/owner/name")).toBe("owner/name");
  });

  it("trims surrounding whitespace", () => {
    expect(deriveOwnerRepo("  git@github.com:owner/name.git\n")).toBe("owner/name");
  });

  it("returns null for a form it doesn't recognise", () => {
    expect(deriveOwnerRepo("not-a-remote-url")).toBeNull();
  });

  it("returns null when the path has fewer than two segments", () => {
    expect(deriveOwnerRepo("git@github.com:name.git")).toBeNull();
  });

  it("returns null for an empty path", () => {
    expect(deriveOwnerRepo("git@github.com:")).toBeNull();
  });

  it("ignores a trailing slash rather than reading it as an empty owner", () => {
    expect(deriveOwnerRepo("https://github.com/owner/name/")).toBe("owner/name");
  });

  it("only strips a `.git` suffix, not an occurrence elsewhere in the path", () => {
    expect(deriveOwnerRepo("https://github.com/owner/name.github")).toBe("owner/name.github");
  });
});
