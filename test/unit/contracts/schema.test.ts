import { describe, expect, it } from "vitest";
import {
  assistantLineSchema,
  contentBlockSchema,
  envelopeSchema,
  otherLineSchema,
  systemLineSchema,
  transcriptLineSchema,
  userLineSchema,
} from "../../../src/core/contracts/schema.js";

const validEnvelope = {
  uuid: "u1",
  parentUuid: null,
  sessionId: "s1",
  timestamp: "2026-01-01T00:00:00Z",
};

const validContentBlockText = { type: "text", text: "hello" };

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
});
