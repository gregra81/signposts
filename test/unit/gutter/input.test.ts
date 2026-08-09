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

describe("toGutterInputTurn — flattenContent edge cases", () => {
  const humanLineWithContent = (content: unknown): UserLine => ({
    ...baseEnvelope,
    type: "user",
    origin: { kind: "human" },
    message: { role: "user", content },
  });

  it("skips a non-object array element (typeof block !== 'object')", () => {
    const turn = toGutterInputTurn(humanLineWithContent([42, { type: "text", text: "kept" }]));
    expect(turn).toEqual({ role: "human", text: "kept", at: "2026-01-01T00:00:00Z" });
  });

  it("skips a null array element (block !== null)", () => {
    const turn = toGutterInputTurn(humanLineWithContent([null, { type: "text", text: "kept" }]));
    expect(turn).toEqual({ role: "human", text: "kept", at: "2026-01-01T00:00:00Z" });
  });

  it("skips an object block whose type is not 'text'", () => {
    const turn = toGutterInputTurn(humanLineWithContent([{ type: "thinking", thinking: "hmm" }]));
    expect(turn).toEqual({ role: "human", text: "", at: "2026-01-01T00:00:00Z" });
  });

  it("skips a text block whose text field is missing", () => {
    const turn = toGutterInputTurn(humanLineWithContent([{ type: "text" }]));
    expect(turn).toEqual({ role: "human", text: "", at: "2026-01-01T00:00:00Z" });
  });

  it("skips a text block whose text field is non-string", () => {
    const turn = toGutterInputTurn(humanLineWithContent([{ type: "text", text: 123 }]));
    expect(turn).toEqual({ role: "human", text: "", at: "2026-01-01T00:00:00Z" });
  });

  it("skips a non-text block even when it happens to carry a text field", () => {
    const turn = toGutterInputTurn(humanLineWithContent([{ type: "tool_result", text: "leaked" }]));
    expect(turn).toEqual({ role: "human", text: "", at: "2026-01-01T00:00:00Z" });
  });

  it("skips a non-object block even when it carries type/text properties (typeof !== 'object')", () => {
    const fnBlock = Object.assign(() => {}, { type: "text", text: "fn-text" });
    const turn = toGutterInputTurn(humanLineWithContent([fnBlock]));
    expect(turn).toEqual({ role: "human", text: "", at: "2026-01-01T00:00:00Z" });
  });

  it("returns empty text when message is absent (content is neither string nor array)", () => {
    const line: UserLine = {
      ...baseEnvelope,
      type: "user",
      origin: { kind: "human" },
    };
    expect(toGutterInputTurn(line)).toEqual({ role: "human", text: "", at: "2026-01-01T00:00:00Z" });
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
  it("wraps plain-string content as a single text block", () => {
    const line: AssistantLine = {
      ...baseEnvelope,
      type: "assistant",
      message: { role: "assistant", content: "plain reply" },
    };
    expect(toGutterInputTurn(line)).toEqual({
      role: "assistant",
      blocks: [{ type: "text", text: "plain reply" }],
      at: "2026-01-01T00:00:00Z",
    });
  });

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

  it("drops a tool_use block missing id, rather than admitting a nameless-idless tool call", () => {
    const line: AssistantLine = {
      ...baseEnvelope,
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Read", input: { file_path: "/a.ts" } }],
      },
    };
    expect(toGutterInputTurn(line)).toEqual({
      role: "assistant",
      blocks: [],
      at: "2026-01-01T00:00:00Z",
    });
  });

  it("drops a non-object array element (typeof block !== 'object')", () => {
    const line: AssistantLine = {
      ...baseEnvelope,
      type: "assistant",
      message: {
        role: "assistant",
        content: [42, { type: "text", text: "kept" }],
      },
    };
    expect(toGutterInputTurn(line)).toEqual({
      role: "assistant",
      blocks: [{ type: "text", text: "kept" }],
      at: "2026-01-01T00:00:00Z",
    });
  });

  it("drops a null array element (block === null)", () => {
    const line: AssistantLine = {
      ...baseEnvelope,
      type: "assistant",
      message: {
        role: "assistant",
        content: [null, { type: "text", text: "kept" }],
      },
    };
    expect(toGutterInputTurn(line)).toEqual({
      role: "assistant",
      blocks: [{ type: "text", text: "kept" }],
      at: "2026-01-01T00:00:00Z",
    });
  });

  it("drops an object block with no type field (type isn't a string)", () => {
    const line: AssistantLine = {
      ...baseEnvelope,
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ foo: "bar" }, { type: "text", text: "kept" }],
      },
    };
    expect(toGutterInputTurn(line)).toEqual({
      role: "assistant",
      blocks: [{ type: "text", text: "kept" }],
      at: "2026-01-01T00:00:00Z",
    });
  });

  it("keeps a tool_result block that has a string tool_use_id", () => {
    const line: AssistantLine = {
      ...baseEnvelope,
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_result", tool_use_id: "1", content: "ok" }],
      },
    };
    expect(toGutterInputTurn(line)).toEqual({
      role: "assistant",
      blocks: [{ type: "tool_result", tool_use_id: "1", content: "ok" }],
      at: "2026-01-01T00:00:00Z",
    });
  });

  it("drops a non-object element even when it carries a string type property (typeof !== 'object')", () => {
    const fnBlock = Object.assign(() => {}, { type: "text", text: "fn-text" });
    const line: AssistantLine = {
      ...baseEnvelope,
      type: "assistant",
      message: {
        role: "assistant",
        content: [fnBlock],
      },
    };
    expect(toGutterInputTurn(line)).toEqual({
      role: "assistant",
      blocks: [],
      at: "2026-01-01T00:00:00Z",
    });
  });

  it("passes a thinking block through unchanged (no id/name/tool_use_id required)", () => {
    const line: AssistantLine = {
      ...baseEnvelope,
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "pondering" }],
      },
    };
    expect(toGutterInputTurn(line)).toEqual({
      role: "assistant",
      blocks: [{ type: "thinking", thinking: "pondering" }],
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
