import { describe, expect, it } from "vitest";
import {
  assistantLineSchema,
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

  describe("userLineSchema", () => {
    const valid = { ...validEnvelope, type: "user", message: { role: "user", content: "hi" } };

    it("parses a valid user line", () => {
      expect(userLineSchema.safeParse(valid).success).toBe(true);
    });
  });

  describe("assistantLineSchema", () => {
    const valid = {
      ...validEnvelope,
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
    };

    it("parses a valid assistant line", () => {
      expect(assistantLineSchema.safeParse(valid).success).toBe(true);
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

    it("parses a real sidecar line with no envelope at all (R7)", () => {
      expect(otherLineSchema.safeParse({ type: "mode", mode: "normal" }).success).toBe(true);
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
        message: { role: "not-user", content: "hi" },
      });
      expect(result.success).toBe(false);
      expect(result.success === false && result.error.issues[0]!.code).toBe("invalid_union");
      expect(
        result.success === false &&
          (result.error.issues[0] as { errors: { path: PropertyKey[] }[][] }).errors.some((branch) =>
            branch.some((issue) => issue.path.join(".") === "message.role"),
          ),
      ).toBe(true);
    });
  });
});
