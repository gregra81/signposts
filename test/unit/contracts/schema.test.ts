import { describe, expect, it } from "vitest";
import {
  assistantLineSchema,
  candidateSchema,
  categorySchema,
  classificationKindSchema,
  classificationSchema,
  contentBlockSchema,
  criticVerdictSchema,
  envelopeSchema,
  gateReasonSchema,
  gatedOperationsSchema,
  graphStateSchema,
  gutteredSessionSchema,
  gutteredTurnSchema,
  humanDecisionSchema,
  nodeNameSchema,
  operationSchema,
  otherLineSchema,
  provenanceSchema,
  resolutionSchema,
  scopeSchema,
  signpostSchema,
  systemLineSchema,
  toolDefSchema,
  transcriptLineSchema,
  usageSchema,
  userLineSchema,
} from "../../../src/core/contracts/schema.js";
import { CLAIM_MAX_CHARS, STATE_VERSION } from "../../../src/core/config/constants.js";

const validScope = { repo: "owner/name", paths: ["src/"], tools: ["git"] };

const validProvenance = {
  session_ids: ["s1"],
  authors: ["dev@example.com"],
  first_seen: "2026-01-01",
  last_reinforced: "2026-01-02",
};

const validSignpost = {
  id: "prefers-tabs",
  claim: "Dev prefers tabs over spaces.",
  category: "preference",
  scope: validScope,
  evidence: "Stated directly in chat.",
  confidence: 0.9,
  provenance: validProvenance,
  status: "active",
};

const validCandidate = {
  tempId: "t1",
  claim: "Dev prefers tabs over spaces.",
  category: "preference",
  scope: validScope,
  evidence: "Stated directly in chat.",
  confidence: 0.9,
  hedged: false,
};

const validEnvelope = {
  uuid: "u1",
  parentUuid: null,
  sessionId: "s1",
  timestamp: "2026-01-01T00:00:00Z",
};

const validContentBlockText = { type: "text", text: "hello" };

const validGutteredTurn = { role: "human", text: "hi", at: "2026-01-01T00:00:00Z" };

const validOperationReinforce = {
  op: "reinforce",
  id: "prefers-tabs",
  sessionId: "s1",
  author: "dev@example.com",
};

// Shared shape of a zod v4 union's per-branch error list (each branch is its
// own array of issues). Used to look past the top-level `invalid_union`
// wrapper at a specific branch's path and message.
type UnionBranchErrors = { errors: { path: PropertyKey[]; message: string }[][] };

function hasBranchIssue(errors: UnionBranchErrors["errors"], path: string, message: string): boolean {
  return errors.some((branch) => branch.some((issue) => issue.path.join(".") === path && issue.message === message));
}

describe("contracts/schema", () => {
  describe("envelopeSchema", () => {
    it("parses a valid envelope", () => {
      expect(envelopeSchema.safeParse(validEnvelope).success).toBe(true);
    });

    it("rejects a non-string parentUuid", () => {
      const result = envelopeSchema.safeParse({ ...validEnvelope, parentUuid: 123 });
      expect(result.success).toBe(false);
      expect(result.success === false && result.error.issues[0]!.path).toEqual(["parentUuid"]);
    });

    it("rejects a missing required field (uuid)", () => {
      const { uuid, ...rest } = validEnvelope;
      const result = envelopeSchema.safeParse(rest);
      expect(result.success).toBe(false);
      expect(result.success === false && result.error.issues[0]!.path).toEqual(["uuid"]);
    });
  });

  describe("contentBlockSchema", () => {
    it("parses a valid text block", () => {
      expect(contentBlockSchema.safeParse(validContentBlockText).success).toBe(true);
    });

    it("rejects a text block with a non-string text field", () => {
      const result = contentBlockSchema.safeParse({ type: "text", text: 123 });
      expect(result.success).toBe(false);
      expect(result.success === false && result.error.issues[0]!.code).toBe("invalid_union");
      const errors = result.success === false && (result.error.issues[0] as UnionBranchErrors).errors;
      expect(
        errors && errors.some((branch) => branch.some((issue) => issue.path.join(".") === "text")),
      ).toBe(true);
      // The catch-all's fatal superRefine (matched because "text" is a known
      // tag) is also a branch in the union failure.
      expect(errors && hasBranchIssue(errors, "type", "known block type")).toBe(true);
    });

    it("rejects a thinking block with a non-string thinking field", () => {
      const result = contentBlockSchema.safeParse({ type: "thinking", thinking: 123 });
      expect(result.success).toBe(false);
      expect(result.success === false && result.error.issues[0]!.code).toBe("invalid_union");
      const errors = result.success === false && (result.error.issues[0] as UnionBranchErrors).errors;
      expect(errors && hasBranchIssue(errors, "type", "known block type")).toBe(true);
    });

    it("rejects a tool_use block with a non-string id", () => {
      const result = contentBlockSchema.safeParse({ type: "tool_use", id: 123 });
      expect(result.success).toBe(false);
      expect(result.success === false && result.error.issues[0]!.code).toBe("invalid_union");
      const errors = result.success === false && (result.error.issues[0] as UnionBranchErrors).errors;
      expect(errors && hasBranchIssue(errors, "type", "known block type")).toBe(true);
    });

    it("rejects a tool_result block with a non-string tool_use_id", () => {
      const result = contentBlockSchema.safeParse({ type: "tool_result", tool_use_id: 123 });
      expect(result.success).toBe(false);
      expect(result.success === false && result.error.issues[0]!.code).toBe("invalid_union");
      const errors = result.success === false && (result.error.issues[0] as UnionBranchErrors).errors;
      expect(errors && hasBranchIssue(errors, "type", "known block type")).toBe(true);
    });

    it("accepts an unrecognised block type (unknown types are skipped downstream, not rejected)", () => {
      expect(contentBlockSchema.safeParse({ type: "image", source: {} }).success).toBe(true);
    });
  });

  describe("userLineSchema", () => {
    const valid = { ...validEnvelope, type: "user", message: { role: "user", content: "hi" } };

    it("parses a valid user line", () => {
      expect(userLineSchema.safeParse(valid).success).toBe(true);
    });

    it("rejects a message.content that is neither string nor block array", () => {
      const result = userLineSchema.safeParse({
        ...valid,
        message: { role: "user", content: 123 },
      });
      expect(result.success).toBe(false);
      expect(result.success === false && result.error.issues[0]!.path).toEqual(["message", "content"]);
    });
  });

  describe("assistantLineSchema", () => {
    const valid = {
      ...validEnvelope,
      type: "assistant",
      message: { role: "assistant", content: [validContentBlockText] },
    };

    it("parses a valid assistant line", () => {
      expect(assistantLineSchema.safeParse(valid).success).toBe(true);
    });

    it("rejects message.content that is not an array", () => {
      const result = assistantLineSchema.safeParse({
        ...valid,
        message: { role: "assistant", content: "not an array" },
      });
      expect(result.success).toBe(false);
      expect(result.success === false && result.error.issues[0]!.path).toEqual(["message", "content"]);
    });
  });

  describe("systemLineSchema", () => {
    const valid = { ...validEnvelope, type: "system" };

    it("parses a valid system line", () => {
      expect(systemLineSchema.safeParse(valid).success).toBe(true);
    });

    it("rejects the wrong type tag", () => {
      const result = systemLineSchema.safeParse({ ...valid, type: "user" });
      expect(result.success).toBe(false);
      expect(result.success === false && result.error.issues[0]!.path).toEqual(["type"]);
    });
  });

  describe("otherLineSchema", () => {
    const valid = { ...validEnvelope, type: "some-unrecognised-type" };

    it("parses a valid other line", () => {
      expect(otherLineSchema.safeParse(valid).success).toBe(true);
    });

    it("rejects a non-string type tag", () => {
      const result = otherLineSchema.safeParse({ ...valid, type: 123 });
      expect(result.success).toBe(false);
      expect(result.success === false && result.error.issues[0]!.path).toEqual(["type"]);
    });

    it("rejects a known line type tag directly (it belongs to userLineSchema, not here)", () => {
      const result = otherLineSchema.safeParse({ ...valid, type: "user" });
      expect(result.success).toBe(false);
      expect(result.success === false && result.error.issues[0]!.path).toEqual(["type"]);
      expect(result.success === false && result.error.issues[0]!.message).toBe("known line type");
    });

    it("rejects the assistant tag directly", () => {
      const result = otherLineSchema.safeParse({ ...valid, type: "assistant" });
      expect(result.success).toBe(false);
      expect(result.success === false && result.error.issues[0]!.path).toEqual(["type"]);
      expect(result.success === false && result.error.issues[0]!.message).toBe("known line type");
    });

    it("rejects the system tag directly", () => {
      const result = otherLineSchema.safeParse({ ...valid, type: "system" });
      expect(result.success).toBe(false);
      expect(result.success === false && result.error.issues[0]!.path).toEqual(["type"]);
      expect(result.success === false && result.error.issues[0]!.message).toBe("known line type");
    });
  });

  describe("transcriptLineSchema", () => {
    it("parses a valid line of any recognised variant", () => {
      expect(transcriptLineSchema.safeParse({ ...validEnvelope, type: "system" }).success).toBe(true);
    });

    it("rejects a line whose type tag is not a string at all", () => {
      const result = transcriptLineSchema.safeParse({ ...validEnvelope, type: 123 });
      expect(result.success).toBe(false);
      expect(result.success === false && result.error.issues[0]!.code).toBe("invalid_union");
      expect(
        result.success === false &&
          (result.error.issues[0] as { errors: { path: PropertyKey[] }[][] }).errors.some((branch) =>
            branch.some((issue) => issue.path.join(".") === "type"),
          ),
      ).toBe(true);
    });

    it("rejects a user-tagged line with a malformed message instead of silently falling through to OtherLine", () => {
      const result = transcriptLineSchema.safeParse({
        ...validEnvelope,
        type: "user",
        message: { role: "user", content: 123 },
      });
      expect(result.success).toBe(false);
      expect(result.success === false && result.error.issues[0]!.code).toBe("invalid_union");
      expect(
        result.success === false &&
          (result.error.issues[0] as { errors: { path: PropertyKey[] }[][] }).errors.some((branch) =>
            branch.some((issue) => issue.path.join(".") === "message.content"),
          ),
      ).toBe(true);
    });
  });

  describe("gutteredTurnSchema", () => {
    it("parses a valid turn", () => {
      expect(gutteredTurnSchema.safeParse(validGutteredTurn).success).toBe(true);
    });

    it("rejects an unrecognised role", () => {
      const result = gutteredTurnSchema.safeParse({ ...validGutteredTurn, role: "robot" });
      expect(result.success).toBe(false);
      expect(result.success === false && result.error.issues[0]!.path).toEqual(["role"]);
    });
  });

  describe("gutteredSessionSchema", () => {
    const valid = {
      sessionId: "s1",
      contentHash: "abc123",
      repo: "owner/name",
      repoRoot: "/repo",
      startedAt: "2026-01-01T00:00:00Z",
      lastActivityAt: "2026-01-01T01:00:00Z",
      turns: [validGutteredTurn],
      tokenEstimate: 150,
      redactionCount: 0,
    };

    it("parses a valid session", () => {
      expect(gutteredSessionSchema.safeParse(valid).success).toBe(true);
    });

    it("rejects a malformed turn inside turns", () => {
      const result = gutteredSessionSchema.safeParse({
        ...valid,
        turns: [{ ...validGutteredTurn, role: "robot" }],
      });
      expect(result.success).toBe(false);
      expect(result.success === false && result.error.issues[0]!.path).toEqual(["turns", 0, "role"]);
    });
  });

  describe("categorySchema", () => {
    it("parses a valid category", () => {
      expect(categorySchema.safeParse("gotcha").success).toBe(true);
    });

    it("rejects an unlisted category", () => {
      const result = categorySchema.safeParse("urgent");
      expect(result.success).toBe(false);
      expect(result.success === false && result.error.issues[0]!.path).toEqual([]);
      expect(result.success === false && result.error.issues[0]!.code).toBe("invalid_value");
    });
  });

  describe("scopeSchema", () => {
    it("parses a valid scope", () => {
      expect(scopeSchema.safeParse(validScope).success).toBe(true);
    });

    it("rejects a missing repo", () => {
      const result = scopeSchema.safeParse({ paths: ["src/"] });
      expect(result.success).toBe(false);
      expect(result.success === false && result.error.issues[0]!.path).toEqual(["repo"]);
    });
  });

  describe("provenanceSchema", () => {
    it("parses valid provenance", () => {
      expect(provenanceSchema.safeParse(validProvenance).success).toBe(true);
    });

    it("rejects authors that is not an array", () => {
      const result = provenanceSchema.safeParse({ ...validProvenance, authors: "dev@example.com" });
      expect(result.success).toBe(false);
      expect(result.success === false && result.error.issues[0]!.path).toEqual(["authors"]);
    });
  });

  describe("signpostSchema", () => {
    it("parses a valid signpost", () => {
      expect(signpostSchema.safeParse(validSignpost).success).toBe(true);
    });

    it("rejects an id that does not match ID_PATTERN", () => {
      const result = signpostSchema.safeParse({ ...validSignpost, id: "Not_Kebab_Case" });
      expect(result.success).toBe(false);
      expect(result.success === false && result.error.issues[0]!.path).toEqual(["id"]);
    });

    it("rejects a claim containing a newline", () => {
      const result = signpostSchema.safeParse({ ...validSignpost, claim: "Dev prefers tabs\nover spaces." });
      expect(result.success).toBe(false);
      expect(result.success === false && result.error.issues[0]!.path).toEqual(["claim"]);
    });
  });

  describe("candidateSchema", () => {
    it("parses a valid candidate", () => {
      expect(candidateSchema.safeParse(validCandidate).success).toBe(true);
    });

    it("rejects a confidence outside 0..1", () => {
      const result = candidateSchema.safeParse({ ...validCandidate, confidence: 1.5 });
      expect(result.success).toBe(false);
      expect(result.success === false && result.error.issues[0]!.path).toEqual(["confidence"]);
    });
  });

  describe("criticVerdictSchema", () => {
    const valid = { tempId: "t1", keep: true, reason: "solid evidence" };

    it("parses a valid verdict", () => {
      expect(criticVerdictSchema.safeParse(valid).success).toBe(true);
    });

    it("rejects an adjustedConfidence outside 0..1", () => {
      const result = criticVerdictSchema.safeParse({ ...valid, adjustedConfidence: 2 });
      expect(result.success).toBe(false);
      expect(result.success === false && result.error.issues[0]!.path).toEqual(["adjustedConfidence"]);
    });
  });

  describe("classificationKindSchema", () => {
    it("parses a valid kind", () => {
      expect(classificationKindSchema.safeParse("REFINEMENT").success).toBe(true);
    });

    it("rejects an unlisted kind", () => {
      const result = classificationKindSchema.safeParse("MERGE");
      expect(result.success).toBe(false);
      expect(result.success === false && result.error.issues[0]!.path).toEqual([]);
      expect(result.success === false && result.error.issues[0]!.code).toBe("invalid_value");
    });
  });

  describe("classificationSchema", () => {
    it("parses NOVEL without a relatedId", () => {
      expect(
        classificationSchema.safeParse({ tempId: "t1", kind: "NOVEL", rationale: "new claim" }).success,
      ).toBe(true);
    });

    it("rejects DUPLICATE without a relatedId", () => {
      const result = classificationSchema.safeParse({ tempId: "t1", kind: "DUPLICATE", rationale: "dup" });
      expect(result.success).toBe(false);
      expect(result.success === false && result.error.issues[0]!.path).toEqual(["relatedId"]);
      expect(result.success === false && result.error.issues[0]!.message).toBe(
        "relatedId is required unless kind is NOVEL",
      );
    });

    it("parses DUPLICATE with a relatedId", () => {
      expect(
        classificationSchema.safeParse({ tempId: "t1", kind: "DUPLICATE", relatedId: "prefers-tabs", rationale: "dup" })
          .success,
      ).toBe(true);
    });

    it("parses REFINEMENT with a relatedId", () => {
      expect(
        classificationSchema.safeParse({
          tempId: "t1",
          kind: "REFINEMENT",
          relatedId: "prefers-tabs",
          rationale: "sharper",
        }).success,
      ).toBe(true);
    });

    it("parses CONTRADICTION with a relatedId", () => {
      expect(
        classificationSchema.safeParse({
          tempId: "t1",
          kind: "CONTRADICTION",
          relatedId: "prefers-tabs",
          rationale: "conflicts",
        }).success,
      ).toBe(true);
    });
  });

  describe("resolutionSchema", () => {
    it("parses a valid both_scoped resolution", () => {
      const result = resolutionSchema.safeParse({
        tempId: "t1",
        outcome: "both_scoped",
        reasoning: "both apply",
        newScope: validScope,
        existingScope: validScope,
      });
      expect(result.success).toBe(true);
    });

    it("parses a valid non-both_scoped resolution without newScope or existingScope", () => {
      const result = resolutionSchema.safeParse({
        tempId: "t1",
        outcome: "new_wins",
        reasoning: "new evidence is stronger",
      });
      expect(result.success).toBe(true);
    });

    it("rejects both_scoped without newScope", () => {
      const result = resolutionSchema.safeParse({
        tempId: "t1",
        outcome: "both_scoped",
        reasoning: "both apply",
        existingScope: validScope,
      });
      expect(result.success).toBe(false);
      const issue = result.success === false && result.error.issues.find((i) => i.path.join(".") === "newScope");
      expect(issue && "message" in issue && issue.message).toBe("newScope is required when outcome is both_scoped");
    });

    it("rejects both_scoped without existingScope", () => {
      const result = resolutionSchema.safeParse({
        tempId: "t1",
        outcome: "both_scoped",
        reasoning: "both apply",
        newScope: validScope,
      });
      expect(result.success).toBe(false);
      const issue = result.success === false && result.error.issues.find((i) => i.path.join(".") === "existingScope");
      expect(issue && "message" in issue && issue.message).toBe(
        "existingScope is required when outcome is both_scoped",
      );
    });

    it("rejects both_scoped without newScope or existingScope, reporting both", () => {
      const result = resolutionSchema.safeParse({
        tempId: "t1",
        outcome: "both_scoped",
        reasoning: "both apply",
      });
      expect(result.success).toBe(false);
      const paths = result.success === false ? result.error.issues.map((i) => i.path.join(".")) : [];
      expect(paths).toContain("newScope");
      expect(paths).toContain("existingScope");
    });
  });

  describe("operationSchema", () => {
    it("parses a valid reinforce operation", () => {
      expect(operationSchema.safeParse(validOperationReinforce).success).toBe(true);
    });

    it("rejects a refine operation whose claim exceeds CLAIM_MAX_CHARS", () => {
      const result = operationSchema.safeParse({
        op: "refine",
        id: "prefers-tabs",
        claim: "x".repeat(CLAIM_MAX_CHARS + 1),
      });
      expect(result.success).toBe(false);
      expect(result.success === false && result.error.issues[0]!.path).toEqual(["claim"]);
    });
  });

  describe("gateReasonSchema", () => {
    it("parses a valid reason", () => {
      expect(gateReasonSchema.safeParse("bootstrap_run").success).toBe(true);
    });

    it("rejects an unlisted reason", () => {
      const result = gateReasonSchema.safeParse("no_reason");
      expect(result.success).toBe(false);
      expect(result.success === false && result.error.issues[0]!.path).toEqual([]);
      expect(result.success === false && result.error.issues[0]!.code).toBe("invalid_value");
    });
  });

  describe("gatedOperationsSchema", () => {
    const valid = {
      auto: [validOperationReinforce],
      needsHuman: [{ operation: validOperationReinforce, reason: "low_confidence" }],
    };

    it("parses valid gated operations", () => {
      expect(gatedOperationsSchema.safeParse(valid).success).toBe(true);
    });

    it("rejects an unlisted reason inside needsHuman", () => {
      const result = gatedOperationsSchema.safeParse({
        ...valid,
        needsHuman: [{ operation: validOperationReinforce, reason: "no_reason" }],
      });
      expect(result.success).toBe(false);
      expect(result.success === false && result.error.issues[0]!.path).toEqual(["needsHuman", 0, "reason"]);
    });
  });

  describe("humanDecisionSchema", () => {
    it("parses accept without edited", () => {
      expect(humanDecisionSchema.safeParse({ decision: "accept", decidedAt: "2026-01-01" }).success).toBe(
        true,
      );
    });

    it("rejects edit without edited", () => {
      const result = humanDecisionSchema.safeParse({ decision: "edit", decidedAt: "2026-01-01" });
      expect(result.success).toBe(false);
      expect(result.success === false && result.error.issues[0]!.path).toEqual(["edited"]);
      expect(result.success === false && result.error.issues[0]!.message).toBe("edited is required when decision is edit");
    });

    it("parses edit with edited", () => {
      const result = humanDecisionSchema.safeParse({
        decision: "edit",
        edited: validOperationReinforce,
        decidedAt: "2026-01-01",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("graphStateSchema", () => {
    const valid = {
      version: STATE_VERSION,
      sessionId: "s1",
      repo: "owner/name",
      repoRoot: "/repo",
      contentHash: "abc123",
      transcriptPath: "/repo/.claude/transcript.jsonl",
      gutterStats: { tokenEstimate: 150, humanTurns: 1, redactionCount: 0 },
      candidates: [validCandidate],
      extractAttempts: 0,
      neighbours: {},
      classifications: {},
      resolutions: {},
      operations: [],
      validationErrors: [],
      validateAttempts: 0,
      humanDecisions: {},
    };

    it("parses a valid graph state", () => {
      expect(graphStateSchema.safeParse(valid).success).toBe(true);
    });

    it("rejects a version other than STATE_VERSION", () => {
      const result = graphStateSchema.safeParse({ ...valid, version: 2 });
      expect(result.success).toBe(false);
      expect(result.success === false && result.error.issues[0]!.path).toEqual(["version"]);
    });
  });

  describe("nodeNameSchema", () => {
    it("parses a valid node name", () => {
      expect(nodeNameSchema.safeParse("classify").success).toBe(true);
    });

    it("rejects an unlisted node name", () => {
      const result = nodeNameSchema.safeParse("summarize");
      expect(result.success).toBe(false);
      expect(result.success === false && result.error.issues[0]!.path).toEqual([]);
      expect(result.success === false && result.error.issues[0]!.code).toBe("invalid_value");
    });
  });

  describe("usageSchema", () => {
    const valid = {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      model: "claude-opus-5",
      costUsd: 0.02,
    };

    it("parses valid usage", () => {
      expect(usageSchema.safeParse(valid).success).toBe(true);
    });

    it("rejects a non-numeric inputTokens", () => {
      const result = usageSchema.safeParse({ ...valid, inputTokens: "100" });
      expect(result.success).toBe(false);
      expect(result.success === false && result.error.issues[0]!.path).toEqual(["inputTokens"]);
    });
  });

  describe("toolDefSchema", () => {
    const valid = { name: "read_file", description: "reads a file", inputSchema: { type: "object" } };

    it("parses a valid tool def", () => {
      expect(toolDefSchema.safeParse(valid).success).toBe(true);
    });

    it("rejects a missing name", () => {
      const { name, ...rest } = valid;
      const result = toolDefSchema.safeParse(rest);
      expect(result.success).toBe(false);
      expect(result.success === false && result.error.issues[0]!.path).toEqual(["name"]);
    });
  });
});
