import { describe, expect, it } from "vitest";
import {
  ASSISTANT_HEAD_CHARS,
  ASSISTANT_HEAD_CHARS_ADJACENT,
  ASSISTANT_TAIL_CHARS_ADJACENT,
} from "../../../src/core/config/constants.js";
import { gutterTurns } from "../../../src/core/gutter/gutter.js";
import type { ContentBlock, GutterInputTurn } from "../../../src/core/gutter/types.js";

const human = (text: string, at = "2026-01-01T00:00:00Z"): GutterInputTurn => ({
  role: "human",
  text,
  at,
});

const assistant = (blocks: ContentBlock[], at = "2026-01-01T00:00:01Z"): GutterInputTurn => ({
  role: "assistant",
  blocks,
  at,
});

describe("gutterTurns — human turns (R1)", () => {
  it("passes a human turn through verbatim", () => {
    const text = "mix of what?";
    const [out] = gutterTurns([human(text)]);
    expect(out).toEqual({ role: "human", text, at: "2026-01-01T00:00:00Z" });
  });
});

describe("gutterTurns — assistant reduction (R2, non-adjacent)", () => {
  it("passes a short, non-adjacent assistant turn through unmodified", () => {
    const short = "Done.";
    const turns: GutterInputTurn[] = [assistant([{ type: "text", text: short }]), assistant([{ type: "text", text: "another turn" }])];
    const [out] = gutterTurns(turns);
    expect(out?.text).toBe(short);
  });

  it("cuts a non-adjacent assistant turn's text to ASSISTANT_HEAD_CHARS when over budget", () => {
    const long = "X".repeat(1000) + ".";
    const turns: GutterInputTurn[] = [assistant([{ type: "text", text: long }]), assistant([{ type: "text", text: "next" }])];
    const [out] = gutterTurns(turns);
    expect(out?.text.length).toBeLessThanOrEqual(ASSISTANT_HEAD_CHARS);
  });
});

describe("gutterTurns — adjacency rule (R3)", () => {
  it("gives head+tail budget to the assistant turn immediately preceding a human turn", () => {
    const long = "H".repeat(2000) + "T".repeat(1);
    const turns: GutterInputTurn[] = [assistant([{ type: "text", text: long }]), human("that's great, keep it this way")];
    const [assistantOut] = gutterTurns(turns);
    expect(assistantOut?.text.length).toBeLessThanOrEqual(ASSISTANT_HEAD_CHARS_ADJACENT + ASSISTANT_TAIL_CHARS_ADJACENT);
    expect(assistantOut?.text.length).toBeGreaterThan(ASSISTANT_HEAD_CHARS);
  });

  it("does not give the larger budget to an assistant turn NOT immediately preceding a human turn", () => {
    const long = "A".repeat(2000);
    const turns: GutterInputTurn[] = [
      assistant([{ type: "text", text: long }]),
      assistant([{ type: "text", text: "filler" }]),
      human("ok"),
    ];
    const [firstOut] = gutterTurns(turns);
    expect(firstOut?.text.length).toBeLessThanOrEqual(ASSISTANT_HEAD_CHARS);
  });

  it("a non-adjacent assistant turn of the same length is cut to its head, unlike the adjacent one", () => {
    const long = "A".repeat(2000) + ".";
    const adjacentTurns: GutterInputTurn[] = [assistant([{ type: "text", text: long }]), human("go on")];
    const nonAdjacentTurns: GutterInputTurn[] = [
      assistant([{ type: "text", text: long }]),
      assistant([{ type: "text", text: "filler" }]),
    ];
    const [adjacentOut] = gutterTurns(adjacentTurns);
    const [nonAdjacentOut] = gutterTurns(nonAdjacentTurns);
    expect(adjacentOut?.text.length).toBeGreaterThan(nonAdjacentOut?.text.length ?? 0);
  });
});

describe("gutterTurns — tool_use (R4) and file paths (R5)", () => {
  it("keeps tool names only, dropping arguments and results", () => {
    const [out] = gutterTurns([
      assistant([
        { type: "text", text: "Reading the file." },
        { type: "tool_use", id: "1", name: "Read", input: { file_path: "/repo/src/a.ts" } },
      ]),
    ]);
    expect(out?.toolNames).toEqual(["Read"]);
  });

  it("collects file paths from tool_use inputs that carry one", () => {
    const [out] = gutterTurns([
      assistant([
        { type: "tool_use", id: "1", name: "Edit", input: { file_path: "/repo/src/b.ts", old_string: "x", new_string: "y" } },
        { type: "tool_use", id: "2", name: "Bash", input: { command: "ls" } },
      ]),
    ]);
    expect(out?.filesTouched).toEqual(["/repo/src/b.ts"]);
    expect(out?.toolNames).toEqual(["Edit", "Bash"]);
  });

  it("omits toolNames and filesTouched when there are no tool_use blocks", () => {
    const [out] = gutterTurns([assistant([{ type: "text", text: "just text" }])]);
    expect(out?.toolNames).toBeUndefined();
    expect(out?.filesTouched).toBeUndefined();
  });

  it("does not throw and omits filesTouched when a tool_use input carries no file_path (e.g. Bash)", () => {
    const run = () =>
      gutterTurns([assistant([{ type: "tool_use", id: "1", name: "Bash", input: undefined }])]);
    expect(run).not.toThrow();
    const [out] = run();
    expect(out?.toolNames).toEqual(["Bash"]);
    expect(out?.filesTouched).toBeUndefined();
  });

  it("does not throw and omits filesTouched when a tool_use input is null", () => {
    const run = () => gutterTurns([assistant([{ type: "tool_use", id: "1", name: "Bash", input: null }])]);
    expect(run).not.toThrow();
    const [out] = run();
    expect(out?.toolNames).toEqual(["Bash"]);
    expect(out?.filesTouched).toBeUndefined();
  });
});

describe("gutterTurns — dropped blocks (R6)", () => {
  it("drops thinking blocks entirely, never surfacing their content", () => {
    const [out] = gutterTurns([
      assistant([
        { type: "thinking", thinking: "secret internal reasoning that must not leak" },
        { type: "text", text: "the actual reply" },
      ]),
    ]);
    expect(out?.text).not.toContain("secret internal reasoning");
    expect(out?.text).toBe("the actual reply");
  });

  it("drops tool_result blocks entirely, never surfacing their content", () => {
    const [out] = gutterTurns([
      assistant([
        { type: "tool_result", tool_use_id: "1", content: "huge tool output that must not leak" },
        { type: "text", text: "summary" },
      ]),
    ]);
    expect(out?.text).not.toContain("huge tool output");
    expect(out?.text).toBe("summary");
  });
});
