// The graph regime's schemas. These are the shapes every LLM node's reply is
// validated against, so a refinement that silently stops firing is a
// malformed operation reaching `commit` — the issue path and message are
// asserted exactly, because they are what the retry prompt tells the model.

import { describe, expect, it } from "vitest";
import {
  candidateSchema,
  classificationSchema,
  criticVerdictSchema,
  graphStateSchema,
  humanDecisionSchema,
  operationSchema,
  OPERATION_TAGS,
  resolutionSchema,
} from "../../../src/core/contracts/graph.js";
import { ALWAYS_HUMAN_OPS, STATE_VERSION } from "../../../src/core/config/constants.js";
import type { Signpost } from "../../../src/core/signpost/schema.js";

function signpost(id = "new-claim"): Signpost {
  return {
    id,
    claim: "A durable claim",
    category: "preference",
    scope: { repo: "acme/api" },
    evidence: "Stated by the human.",
    confidence: 0.9,
    provenance: {
      session_ids: ["s1"],
      authors: ["dev@acme.example"],
      first_seen: "2026-08-27",
      last_reinforced: "2026-08-27",
    },
    status: "active",
  };
}

function issuesOf(result: { success: boolean; error?: { issues: readonly { path: PropertyKey[]; message: string }[] } }) {
  return (result.error?.issues ?? []).map((issue) => [issue.path.join("."), issue.message]);
}

describe("OPERATION_TAGS", () => {
  // One home for the three literals that also drive the gate policy: a tag
  // spelled differently here than in ALWAYS_HUMAN_OPS would produce an
  // operation the gate silently treats as auto-publishable.
  it("takes its always-human tags from ALWAYS_HUMAN_OPS", () => {
    expect([OPERATION_TAGS.refine, OPERATION_TAGS.supersede, OPERATION_TAGS.retire]).toEqual([
      ...ALWAYS_HUMAN_OPS,
    ]);
  });

  it("covers every operation the union accepts", () => {
    expect(Object.values(OPERATION_TAGS).sort()).toEqual(
      ["add", "refine", "reinforce", "retire", "supersede"],
    );
  });
});

describe("candidateSchema", () => {
  const valid = {
    tempId: "t1",
    claim: "Staging is read only",
    category: "environment",
    scope: { repo: "acme/api" },
    evidence: "Stated after a failed write.",
    confidence: 0.9,
    hedged: false,
  };

  it("accepts a well-formed candidate", () => {
    expect(candidateSchema.safeParse(valid).success).toBe(true);
  });

  // Claim validation is node 7's job. Enforcing it here would turn a candidate
  // the self-correction loop is designed to repair into a hard failure.
  it("accepts an over-long claim, leaving that to validate", () => {
    expect(candidateSchema.safeParse({ ...valid, claim: "x".repeat(500) }).success).toBe(true);
  });

  it.each([-0.1, 1.1])("rejects a confidence of %s", (confidence) => {
    expect(candidateSchema.safeParse({ ...valid, confidence }).success).toBe(false);
  });

  it("requires hedged to be stated, not inferred from absence", () => {
    const { hedged: _hedged, ...withoutHedged } = valid;
    expect(candidateSchema.safeParse(withoutHedged).success).toBe(false);
  });
});

describe("criticVerdictSchema", () => {
  it("accepts a verdict with no adjustment", () => {
    expect(criticVerdictSchema.safeParse({ tempId: "t1", keep: true, reason: "r" }).success).toBe(
      true,
    );
  });

  it("rejects an adjustment outside 0..1", () => {
    expect(
      criticVerdictSchema.safeParse({ tempId: "t1", keep: true, reason: "r", adjustedConfidence: 2 })
        .success,
    ).toBe(false);
  });
});

describe("classificationSchema", () => {
  it("accepts NOVEL with no relatedId", () => {
    expect(
      classificationSchema.safeParse({ tempId: "t1", kind: "NOVEL", rationale: "r" }).success,
    ).toBe(true);
  });

  it("accepts NOVEL that names a relatedId anyway", () => {
    expect(
      classificationSchema.safeParse({
        tempId: "t1",
        kind: "NOVEL",
        relatedId: "x",
        rationale: "r",
      }).success,
    ).toBe(true);
  });

  it.each(["DUPLICATE", "REFINEMENT", "CONTRADICTION"] as const)(
    "requires relatedId for %s, and says which field and why",
    (kind) => {
      const result = classificationSchema.safeParse({ tempId: "t1", kind, rationale: "r" });
      expect(result.success).toBe(false);
      expect(issuesOf(result)).toEqual([["relatedId", `relatedId is required when kind is ${kind}`]]);
    },
  );

  it.each(["DUPLICATE", "REFINEMENT", "CONTRADICTION"] as const)(
    "accepts %s once relatedId is present",
    (kind) => {
      expect(
        classificationSchema.safeParse({ tempId: "t1", kind, relatedId: "x", rationale: "r" })
          .success,
      ).toBe(true);
    },
  );

  it("rejects a kind outside the four", () => {
    expect(
      classificationSchema.safeParse({ tempId: "t1", kind: "MAYBE", rationale: "r" }).success,
    ).toBe(false);
  });
});

describe("resolutionSchema", () => {
  const scope = { repo: "acme/api" };

  it.each(["new_wins", "existing_wins", "undecidable"] as const)(
    "accepts %s with no scopes",
    (outcome) => {
      expect(resolutionSchema.safeParse({ tempId: "t1", outcome, reasoning: "r" }).success).toBe(
        true,
      );
    },
  );

  it("accepts both_scoped with both scopes", () => {
    expect(
      resolutionSchema.safeParse({
        tempId: "t1",
        outcome: "both_scoped",
        reasoning: "r",
        newScope: scope,
        existingScope: scope,
      }).success,
    ).toBe(true);
  });

  it("reports both missing scopes, each by name", () => {
    const result = resolutionSchema.safeParse({
      tempId: "t1",
      outcome: "both_scoped",
      reasoning: "r",
    });
    expect(result.success).toBe(false);
    expect(issuesOf(result)).toEqual([
      ["newScope", "newScope is required when outcome is both_scoped"],
      ["existingScope", "existingScope is required when outcome is both_scoped"],
    ]);
  });

  it.each([
    ["newScope", { existingScope: scope }],
    ["existingScope", { newScope: scope }],
  ])("reports %s when only that one is missing", (missing, present) => {
    const result = resolutionSchema.safeParse({
      tempId: "t1",
      outcome: "both_scoped",
      reasoning: "r",
      ...present,
    });
    expect(result.success).toBe(false);
    expect(issuesOf(result)).toEqual([[missing, `${missing} is required when outcome is both_scoped`]]);
  });

  it("accepts evidenceChecked when the resolver cites what it read", () => {
    expect(
      resolutionSchema.safeParse({
        tempId: "t1",
        outcome: "new_wins",
        reasoning: "r",
        evidenceChecked: ["config/staging.yaml"],
      }).success,
    ).toBe(true);
  });
});

describe("operationSchema", () => {
  it.each([
    ["add", { op: "add", signpost: signpost() }],
    ["reinforce", { op: "reinforce", id: "known", sessionId: "s1", author: "dev@acme.example" }],
    ["refine", { op: "refine", id: "known", sessionId: "s1", author: "dev@acme.example" }],
    ["supersede", { op: "supersede", id: "known", replacement: signpost("newer") }],
    ["retire", { op: "retire", id: "known", reason: "obsolete" }],
  ])("accepts a well-formed %s", (_name, operation) => {
    expect(operationSchema.safeParse(operation).success).toBe(true);
  });

  it("rejects an unknown op tag", () => {
    expect(operationSchema.safeParse({ op: "delete", id: "known" }).success).toBe(false);
  });

  // refine edits a real claim, so it gets the full claim rules — unlike a
  // candidate, which validate checks later.
  it("rejects a refine whose replacement claim breaks the claim rules", () => {
    expect(
      operationSchema.safeParse({ op: "refine", id: "known", claim: "x".repeat(500) }).success,
    ).toBe(false);
  });
});

describe("humanDecisionSchema", () => {
  const decidedAt = "2026-08-30T09:00:00.000Z";

  it.each(["accept", "reject"] as const)("accepts %s with no replacement", (decision) => {
    expect(humanDecisionSchema.safeParse({ decision, decidedAt }).success).toBe(true);
  });

  it("accepts an edit that carries its replacement", () => {
    expect(
      humanDecisionSchema.safeParse({
        decision: "edit",
        edited: { op: "retire", id: "known", reason: "by hand" },
        decidedAt,
      }).success,
    ).toBe(true);
  });

  // An edit with nothing to apply is the one decision that cannot be honoured.
  it("rejects an edit with no replacement, and says which field is missing", () => {
    const result = humanDecisionSchema.safeParse({ decision: "edit", decidedAt });
    expect(result.success).toBe(false);
    expect(issuesOf(result)).toEqual([["edited", 'edited is required when decision is "edit"']]);
  });

  it("does not demand a replacement for a rejection", () => {
    expect(humanDecisionSchema.safeParse({ decision: "reject", decidedAt }).success).toBe(true);
  });

  it("rejects a decision outside the three", () => {
    expect(humanDecisionSchema.safeParse({ decision: "maybe", decidedAt }).success).toBe(false);
  });
});

describe("graphStateSchema", () => {
  const state = {
    version: STATE_VERSION,
    sessionId: "s1",
    repo: "acme/api",
    repoRoot: "/repo",
    contentHash: "hash-1",
    transcriptPath: "/t.jsonl",
    gutterStats: { tokenEstimate: 500, humanTurns: 1, redactionCount: 0 },
    candidates: [],
    extractAttempts: 0,
    criticRetries: 0,
    neighbours: {},
    classifications: {},
    resolutions: {},
    validated: [],
    operations: [],
    gated: { auto: [], needsHuman: [] },
    validationErrors: [],
    validateAttempts: 0,
    humanDecisions: {},
  };

  it("accepts a state at the current version", () => {
    expect(graphStateSchema.safeParse(state).success).toBe(true);
  });

  // The version is pinned, not merely typed as a number: that is what makes a
  // checkpoint from another shape recognisable as foreign.
  it("rejects a state carrying any other version", () => {
    expect(graphStateSchema.safeParse({ ...state, version: STATE_VERSION + 1 }).success).toBe(false);
  });

  // Records, never Maps: a Map does not survive JSON serialisation into a
  // checkpoint, and would resume as {} with no error.
  it("keeps the keyed channels as plain records", () => {
    const parsed = graphStateSchema.parse({
      ...state,
      classifications: { t1: { tempId: "t1", kind: "NOVEL", rationale: "r" } },
    });
    expect(parsed.classifications).toEqual({ t1: { tempId: "t1", kind: "NOVEL", rationale: "r" } });
  });

  // Guttered text has no field here, by design — everything in state is
  // written to the checkpoint database on every node transition.
  it("has no channel for transcript text", () => {
    const parsed = graphStateSchema.parse({ ...state, turns: ["human: secret"] });
    expect(Object.keys(parsed)).not.toContain("turns");
  });
});
