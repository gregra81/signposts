import { describe, expect, it } from "vitest";
import { signpostSchema } from "../../../src/core/signpost/schema.js";
import { CLAIM_MAX_CHARS, CLAIM_REJECT_SUBSTRINGS } from "../../../src/core/config/constants.js";

const VALID: import("../../../src/core/signpost/schema.js").Signpost = {
  id: "staging-db-read-only",
  claim: "The staging database is read-only; run migrations against dev instead.",
  category: "environment",
  scope: { repo: "acme/platform", paths: ["prisma/**"] },
  evidence: "A migration run against staging failed with a permissions error.",
  confidence: 0.91,
  provenance: {
    session_ids: ["s1"],
    authors: ["rashkevitch@gmail.com"],
    first_seen: "2026-07-14",
    last_reinforced: "2026-07-28",
  },
  status: "active",
};

describe("signpostSchema", () => {
  it("parses a valid signpost", () => {
    expect(signpostSchema.safeParse(VALID).success).toBe(true);
  });

  it("parses a valid signpost carrying supersedes", () => {
    const result = signpostSchema.safeParse({ ...VALID, status: "active", supersedes: ["old-id"] });
    expect(result.success).toBe(true);
  });

  it("rejects an id that isn't a kebab-case slug", () => {
    const result = signpostSchema.safeParse({ ...VALID, id: "Not_A_Slug" });
    expect(result.success).toBe(false);
    expect(result.success === false && result.error.issues[0]!.path).toEqual(["id"]);
  });

  it("rejects a category outside the enum", () => {
    const result = signpostSchema.safeParse({ ...VALID, category: "bogus" });
    expect(result.success).toBe(false);
  });

  it("rejects confidence outside 0..1", () => {
    expect(signpostSchema.safeParse({ ...VALID, confidence: 1.1 }).success).toBe(false);
    expect(signpostSchema.safeParse({ ...VALID, confidence: -0.1 }).success).toBe(false);
  });

  it("rejects evidence over EVIDENCE_MAX_CHARS", () => {
    const result = signpostSchema.safeParse({ ...VALID, evidence: "x".repeat(501) });
    expect(result.success).toBe(false);
  });

  describe("claim validation", () => {
    it("rejects a claim containing a newline", () => {
      const result = signpostSchema.safeParse({ ...VALID, claim: "First sentence.\nSecond sentence." });
      expect(result.success).toBe(false);
      expect(
        result.success === false &&
          result.error.issues.some((i) => i.path.join(".") === "claim" && i.message.includes("newline")),
      ).toBe(true);
    });

    it("rejects a claim exceeding CLAIM_MAX_CHARS", () => {
      const claim = `${"a".repeat(CLAIM_MAX_CHARS)}b`;
      expect(claim.length).toBe(CLAIM_MAX_CHARS + 1);
      const result = signpostSchema.safeParse({ ...VALID, claim });
      expect(result.success).toBe(false);
      expect(
        result.success === false &&
          result.error.issues.some((i) => i.path.join(".") === "claim" && i.message.includes("exceeds")),
      ).toBe(true);
    });

    it("accepts a claim at exactly CLAIM_MAX_CHARS", () => {
      const claim = "a".repeat(CLAIM_MAX_CHARS);
      const result = signpostSchema.safeParse({ ...VALID, claim });
      expect(result.success).toBe(true);
    });

    it.each(CLAIM_REJECT_SUBSTRINGS)("rejects a claim smuggling a second proposition via %j", (substring) => {
      const claim = `First part${substring}second part.`;
      const result = signpostSchema.safeParse({ ...VALID, claim });
      expect(result.success).toBe(false);
      expect(
        result.success === false &&
          result.error.issues.some((i) => i.path.join(".") === "claim" && i.message.includes("smuggles")),
      ).toBe(true);
    });

    it("accumulates multiple claim issues at once (newline + too long + smuggled)", () => {
      const substring = CLAIM_REJECT_SUBSTRINGS[0];
      const claim = `${"a".repeat(CLAIM_MAX_CHARS)}${substring}b\nc`;
      const result = signpostSchema.safeParse({ ...VALID, claim });
      expect(result.success).toBe(false);
      const claimIssues = result.success === false ? result.error.issues.filter((i) => i.path.join(".") === "claim") : [];
      expect(claimIssues.length).toBeGreaterThanOrEqual(3);
    });
  });
});
