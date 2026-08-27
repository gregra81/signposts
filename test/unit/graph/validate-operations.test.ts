import { describe, expect, it } from "vitest";
import {
  isParseableGlob,
  validateOperations,
} from "../../../src/core/graph/validate-operations.js";
import { CLAIM_MAX_CHARS } from "../../../src/core/config/constants.js";
import type { CandidateOperations, Operation } from "../../../src/core/contracts/graph.js";
import type { Signpost } from "../../../src/core/signpost/schema.js";

const EXISTING = new Set(["staging-read-only", "tabs-not-spaces"]);

function signpost(overrides: Partial<Signpost> = {}): Signpost {
  return {
    id: "new-claim",
    claim: "A short durable claim",
    category: "preference",
    scope: { repo: "acme/api" },
    evidence: "The human said so.",
    confidence: 0.9,
    provenance: {
      session_ids: ["s1"],
      authors: ["dev@acme.example"],
      first_seen: "2026-08-27",
      last_reinforced: "2026-08-27",
    },
    status: "active",
    ...overrides,
  };
}

function group(overrides: Partial<CandidateOperations> = {}): CandidateOperations {
  return {
    tempId: "t1",
    confidence: 0.9,
    operations: [{ op: "add", signpost: signpost() }],
    ...overrides,
  };
}

describe("isParseableGlob", () => {
  it.each(["src/**", "src/*.ts", "src/{a,b}/**", "src/[abc]*.ts", "a{b[c]d}e"])(
    "accepts %s",
    (glob) => {
      expect(isParseableGlob(glob)).toBe(true);
    },
  );

  it.each(["", "src/[abc*.ts", "src/{a,b/**", "src/abc]*.ts", "src/a}b"])(
    "rejects %s",
    (glob) => {
      expect(isParseableGlob(glob)).toBe(false);
    },
  );

  // Counts balance, order does not. Without the depth check these read as
  // valid, and a matcher would then throw on a pattern we said was fine.
  it.each(["][", "}{", "a]b[c", "src/}a{b"])("rejects %s, closed before opened", (glob) => {
    expect(isParseableGlob(glob)).toBe(false);
  });
});

describe("validateOperations", () => {
  it("passes a clean batch through with no errors", () => {
    const result = validateOperations({ built: [group()], existingIds: EXISTING });
    expect(result.errors).toEqual([]);
    expect(result.valid).toHaveLength(1);
  });

  it("rejects an operation whose claim is too long", () => {
    const result = validateOperations({
      built: [group({ operations: [{ op: "add", signpost: signpost({ claim: "x".repeat(CLAIM_MAX_CHARS + 1) }) }] })],
      existingIds: EXISTING,
    });
    expect(result.valid).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("t1");
  });

  it("rejects an operation whose claim smuggles a second proposition", () => {
    const result = validateOperations({
      built: [group({ operations: [{ op: "add", signpost: signpost({ claim: "Use tabs and also never push to main" }) }] })],
      existingIds: EXISTING,
    });
    expect(result.valid).toEqual([]);
  });

  it("rejects an invalid category", () => {
    const result = validateOperations({
      built: [
        group({
          operations: [
            { op: "add", signpost: { ...signpost(), category: "nonsense" } as unknown as Signpost },
          ],
        }),
      ],
      existingIds: EXISTING,
    });
    expect(result.valid).toEqual([]);
  });

  it.each([
    ["supersede", { op: "supersede" as const, id: "ghost", replacement: signpost() }],
    ["retire", { op: "retire" as const, id: "ghost", reason: "obsolete" }],
    ["refine", { op: "refine" as const, id: "ghost", claim: "A sharper claim" }],
    ["reinforce", { op: "reinforce" as const, id: "ghost", sessionId: "s1", author: "dev@acme.example" }],
  ])("rejects a %s pointing at an id that does not exist", (_name, operation) => {
    const result = validateOperations({
      built: [group({ operations: [operation] })],
      existingIds: EXISTING,
    });
    expect(result.valid).toEqual([]);
    expect(result.errors[0]).toContain("unknown signpost id");
  });

  it("accepts an operation pointing at an id that does exist", () => {
    const result = validateOperations({
      built: [group({ operations: [{ op: "retire", id: "staging-read-only", reason: "obsolete" }] })],
      existingIds: EXISTING,
    });
    expect(result.errors).toEqual([]);
  });

  it("rejects a second operation targeting a signpost an earlier candidate already claimed", () => {
    const first = group({ tempId: "a", operations: [{ op: "retire", id: "staging-read-only", reason: "obsolete" }] });
    const second = group({ tempId: "b", operations: [{ op: "refine", id: "staging-read-only", claim: "Sharper" }] });
    const result = validateOperations({ built: [first, second], existingIds: EXISTING });
    expect(result.valid.map((c) => c.tempId)).toEqual(["a"]);
    expect(result.errors[0]).toContain("a second time");
  });

  it("rejects one candidate targeting the same signpost twice", () => {
    const result = validateOperations({
      built: [
        group({
          operations: [
            { op: "refine", id: "tabs-not-spaces", claim: "Sharper" },
            { op: "retire", id: "tabs-not-spaces", reason: "obsolete" },
          ],
        }),
      ],
      existingIds: EXISTING,
    });
    expect(result.valid).toEqual([]);
  });

  // A candidate that fails must not reserve its targets, or it would take a
  // perfectly good later candidate down with it.
  it("does not let a failed candidate block a later one from the same target", () => {
    const failing = group({
      tempId: "a",
      operations: [{ op: "refine", id: "staging-read-only", claim: "x".repeat(CLAIM_MAX_CHARS + 1) }],
    });
    const good = group({
      tempId: "b",
      operations: [{ op: "refine", id: "staging-read-only", claim: "A sharper claim" }],
    });
    const result = validateOperations({ built: [failing, good], existingIds: EXISTING });
    expect(result.valid.map((c) => c.tempId)).toEqual(["b"]);
  });

  it.each([
    ["add", (glob: string) => ({ op: "add" as const, signpost: signpost({ scope: { repo: "acme/api", paths: [glob] } }) })],
    ["supersede", (glob: string) => ({ op: "supersede" as const, id: "tabs-not-spaces", replacement: signpost({ scope: { repo: "acme/api", paths: [glob] } }) })],
    ["refine", (glob: string) => ({ op: "refine" as const, id: "tabs-not-spaces", scope: { repo: "acme/api", paths: [glob] } })],
  ])("rejects an unparseable scope glob on %s", (_name, make) => {
    const result = validateOperations({
      built: [group({ operations: [make("src/[abc")] })],
      existingIds: EXISTING,
    });
    expect(result.valid).toEqual([]);
    expect(result.errors[0]).toContain("unparseable scope glob");
  });

  it("accepts a valid scope glob", () => {
    const result = validateOperations({
      built: [group({ operations: [{ op: "add", signpost: signpost({ scope: { repo: "acme/api", paths: ["src/**"] } }) }] })],
      existingIds: EXISTING,
    });
    expect(result.errors).toEqual([]);
  });

  it("does not look for globs on an operation that carries no scope", () => {
    const result = validateOperations({
      built: [group({ operations: [{ op: "retire", id: "tabs-not-spaces", reason: "obsolete" }] })],
      existingIds: EXISTING,
    });
    expect(result.errors).toEqual([]);
  });

  // The bad candidate is dropped whole; the rest of the run carries on.
  it("drops only the offending candidate", () => {
    const bad = group({ tempId: "bad", operations: [{ op: "add", signpost: signpost({ claim: "x".repeat(CLAIM_MAX_CHARS + 1) }) }] });
    const good = group({ tempId: "good" });
    const result = validateOperations({ built: [bad, good], existingIds: EXISTING });
    expect(result.valid.map((c) => c.tempId)).toEqual(["good"]);
    expect(result.errors).toHaveLength(1);
  });

  describe("the error message fed back to extract", () => {
    it("names the field that failed", () => {
      const result = validateOperations({
        built: [group({ operations: [{ op: "add", signpost: signpost({ claim: "x".repeat(CLAIM_MAX_CHARS + 1) }) }] })],
        existingIds: EXISTING,
      });
      expect(result.errors).toEqual([
        `t1: operation failed schema validation: signpost.claim: claim exceeds ${CLAIM_MAX_CHARS} characters`,
      ]);
    });

    it("joins several issues on one operation with a separator", () => {
      const result = validateOperations({
        built: [
          group({
            operations: [
              { op: "add", signpost: signpost({ claim: `${"x".repeat(CLAIM_MAX_CHARS)}\nsecond line` }) },
            ],
          }),
        ],
        existingIds: EXISTING,
      });
      expect(result.errors).toEqual([
        "t1: operation failed schema validation: signpost.claim: claim must be a single sentence: " +
          `no newline allowed; signpost.claim: claim exceeds ${CLAIM_MAX_CHARS} characters`,
      ]);
    });

    it("names the discriminator when the op tag is unknown", () => {
      const result = validateOperations({
        built: [group({ operations: [{ op: "bogus" } as unknown as Operation] })],
        existingIds: EXISTING,
      });
      expect(result.valid).toEqual([]);
      expect(result.errors[0]).toContain("op: Invalid discriminator value");
    });

    // A failure with no field to name at all — the value is not an object, so
    // zod reports it at the root. Without a label the message would read
    // ": Invalid input", which says nothing about where the problem is.
    it("labels a root-level failure", () => {
      const result = validateOperations({
        built: [group({ operations: ["not an operation" as unknown as Operation] })],
        existingIds: EXISTING,
      });
      expect(result.valid).toEqual([]);
      expect(result.errors[0]).toBe(
        "t1: operation failed schema validation: (root): Invalid input: expected object, received string",
      );
    });
  });

  it("returns an empty result for an empty batch", () => {
    expect(validateOperations({ built: [], existingIds: EXISTING })).toEqual({ valid: [], errors: [] });
  });
});
