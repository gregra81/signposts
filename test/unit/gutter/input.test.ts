import { describe, expect, it } from "vitest";
import { toGutterInputTurn } from "../../../src/core/gutter/input.js";
import type { AssistantLine, OtherLine, SystemLine, UserLine } from "../../../src/core/contracts/schema.js";

const baseEnvelope = {
  uuid: "u1",
  parentUuid: null,
  sessionId: "s1",
  timestamp: "2026-01-01T00:00:00Z",
};

describe("toGutterInputTurn — human user lines", () => {
  it("flattens plain-string content directly", () => {
    const line: UserLine = {
      ...baseEnvelope,
      type: "user",
      origin: { kind: "human" },
      message: { role: "user", content: "hello there" },
    };
    expect(toGutterInputTurn(line)).toEqual({
      role: "human",
      text: "hello there",
      at: "2026-01-01T00:00:00Z",
    });
  });

  it("concatenates text blocks and drops non-text blocks in block-array content", () => {
    const line: UserLine = {
      ...baseEnvelope,
      type: "user",
      origin: { kind: "human" },
      message: {
        role: "user",
        content: [
          { type: "text", text: "part one. " },
          { type: "tool_result", tool_use_id: "1", content: "dropped" },
          { type: "text", text: "part two." },
        ],
      },
    };
    const turn = toGutterInputTurn(line);
    expect(turn).toEqual({
      role: "human",
      text: "part one. part two.",
      at: "2026-01-01T00:00:00Z",
    });
  });
});

describe("toGutterInputTurn — non-human user lines", () => {
  it("returns undefined for a user line without origin.kind === human", () => {
    const line: UserLine = {
      ...baseEnvelope,
      type: "user",
      message: { role: "user", content: "<local-command-stdout>noise</local-command-stdout>" },
    };
    expect(toGutterInputTurn(line)).toBeUndefined();
  });
});

describe("toGutterInputTurn — assistant lines", () => {
  it("narrows content into ContentBlock[]", () => {
    const line: AssistantLine = {
      ...baseEnvelope,
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "the reply" },
          { type: "tool_use", id: "1", name: "Read", input: { file_path: "/a.ts" } },
        ],
      },
    };
    expect(toGutterInputTurn(line)).toEqual({
      role: "assistant",
      blocks: [
        { type: "text", text: "the reply" },
        { type: "tool_use", id: "1", name: "Read", input: { file_path: "/a.ts" } },
      ],
      at: "2026-01-01T00:00:00Z",
    });
  });

  it("drops a text block whose text is missing or non-string, rather than fabricating content", () => {
    const line: AssistantLine = {
      ...baseEnvelope,
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text" }, { type: "text", text: 123 }, { type: "text", text: "kept" }],
      },
    };
    expect(toGutterInputTurn(line)).toEqual({
      role: "assistant",
      blocks: [{ type: "text", text: "kept" }],
      at: "2026-01-01T00:00:00Z",
    });
  });

  it("drops a tool_use block missing name, rather than producing toolNames: [undefined]", () => {
    const line: AssistantLine = {
      ...baseEnvelope,
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "1", input: { file_path: "/a.ts" } }],
      },
    };
    expect(toGutterInputTurn(line)).toEqual({
      role: "assistant",
      blocks: [],
      at: "2026-01-01T00:00:00Z",
    });
  });

  it("drops a tool_result block missing tool_use_id", () => {
    const line: AssistantLine = {
      ...baseEnvelope,
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_result", content: "some output" }],
      },
    };
    expect(toGutterInputTurn(line)).toEqual({
      role: "assistant",
      blocks: [],
      at: "2026-01-01T00:00:00Z",
    });
  });
});

describe("toGutterInputTurn — system/other lines", () => {
  it("returns undefined for a system line", () => {
    const line: SystemLine = { ...baseEnvelope, type: "system" };
    expect(toGutterInputTurn(line)).toBeUndefined();
  });

  it("returns undefined for an other (unrecognised-type) line", () => {
    const line: OtherLine = { ...baseEnvelope, type: "mode" };
    expect(toGutterInputTurn(line)).toBeUndefined();
  });
});
