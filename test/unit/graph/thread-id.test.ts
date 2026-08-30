import { describe, expect, it } from "vitest";
import { buildThreadId, THREAD_ID_SEPARATOR } from "../../../src/core/graph/thread-id.js";

const PARTS = { repo: "acme/api", sessionId: "sess-1", contentHash: "abc123" };

describe("buildThreadId", () => {
  it("joins repo, sessionId and contentHash in that order", () => {
    expect(buildThreadId(PARTS)).toBe("acme/api:sess-1:abc123");
  });

  it("uses THREAD_ID_SEPARATOR between every part", () => {
    expect(buildThreadId(PARTS).split(THREAD_ID_SEPARATOR)).toEqual([
      "acme/api",
      "sess-1",
      "abc123",
    ]);
  });

  // The property the three-day review gap depends on: nothing is remembered,
  // so recomputing from the same three on-disk values must give the same id.
  it("is reproducible from the same parts", () => {
    expect(buildThreadId({ ...PARTS })).toBe(buildThreadId(PARTS));
  });

  it.each([
    ["repo", { ...PARTS, repo: "acme/web" }],
    ["sessionId", { ...PARTS, sessionId: "sess-2" }],
    ["contentHash", { ...PARTS, contentHash: "def456" }],
  ])("changes when %s changes", (_field, changed) => {
    expect(buildThreadId(changed)).not.toBe(buildThreadId(PARTS));
  });
});
