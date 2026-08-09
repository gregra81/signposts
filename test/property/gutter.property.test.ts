// Tier 2 property tests for the gutter (16-build-plan.md P1, P2).

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { gutterTurns, stripTaggedNoise } from "../../src/core/gutter/gutter.js";
import { STRIP_TAGS } from "../../src/core/config/constants.js";
import type { ContentBlock, GutterInputTurn } from "../../src/core/gutter/types.js";

// Includes long strings so head/headAndTail actually truncate in some runs —
// fc.string()'s default (~0-10 chars) never crosses the 400/600/900-char
// budgets, which would make P2 trivially true without exercising truncation.
// The `unit: "binary"` arm adds astral characters (surrogate pairs) into the
// mix — fc.string()'s default unit never emits them, so without this arm the
// surrogate-pair truncation guard in budget.ts (see its unit tests) would
// never be exercised here.
const textArb = fc.oneof(
  fc.string(),
  fc.string({ minLength: 500, maxLength: 4000 }),
  fc.string({ unit: "binary", minLength: 1, maxLength: 50 }),
);

const contentBlockArb: fc.Arbitrary<ContentBlock> = fc.oneof(
  fc.record({ type: fc.constant("text" as const), text: textArb }),
  fc.record({ type: fc.constant("thinking" as const), thinking: textArb }),
  fc.record({
    type: fc.constant("tool_use" as const),
    id: fc.string(),
    name: fc.string({ minLength: 1 }),
    input: fc.oneof(
      fc.constant(undefined),
      fc.record(
        { file_path: fc.string(), notebook_path: fc.string(), path: fc.string() },
        { requiredKeys: [] },
      ),
    ),
  }),
  fc.record({ type: fc.constant("tool_result" as const), tool_use_id: fc.string(), content: fc.string() }),
);

// Sometimes wraps a segment in a STRIP_TAGS tag (e.g. <system-reminder>...
// </system-reminder>) so P1 actually exercises stripTaggedNoise, not just
// the identity case.
const humanTextArb = fc.oneof(
  textArb,
  fc
    .tuple(textArb, fc.constantFrom(...STRIP_TAGS), textArb, textArb)
    .map(([before, tag, inner, after]) => `${before}<${tag}>${inner}</${tag}>${after}`),
);

const humanTurnArb: fc.Arbitrary<GutterInputTurn> = fc.record({
  role: fc.constant("human" as const),
  text: humanTextArb,
  at: fc.string(),
});

const assistantTurnArb: fc.Arbitrary<GutterInputTurn> = fc.record({
  role: fc.constant("assistant" as const),
  blocks: fc.array(contentBlockArb, { maxLength: 8 }),
  at: fc.string(),
});

const turnArb = fc.oneof(humanTurnArb, assistantTurnArb);
const turnsArb = fc.array(turnArb, { maxLength: 20 });

/** Sum of every text-bearing field the wire ContentBlock union carries. */
function inputTurnLength(turn: GutterInputTurn): number {
  if (turn.role === "human") {
    return turn.text.length;
  }
  return turn.blocks.reduce((sum, block) => {
    if (block.type === "text") return sum + block.text.length;
    if (block.type === "thinking") return sum + (block.thinking?.length ?? 0);
    if (block.type === "tool_use") {
      const record =
        typeof block.input === "object" && block.input !== null ? (block.input as Record<string, unknown>) : {};
      const pathKeysLength = ["file_path", "notebook_path", "path"].reduce((keySum, key) => {
        const value = record[key];
        return keySum + (typeof value === "string" ? value.length : 0);
      }, 0);
      return sum + block.name.length + pathKeysLength;
    }
    return sum + (typeof block.content === "string" ? block.content.length : 0);
  }, 0);
}

function outputTurnLength(turn: ReturnType<typeof gutterTurns>[number]): number {
  const toolNamesLength = (turn.toolNames ?? []).reduce((sum, name) => sum + name.length, 0);
  const filesLength = (turn.filesTouched ?? []).reduce((sum, path) => sum + path.length, 0);
  return turn.text.length + toolNamesLength + filesLength;
}

describe("gutterTurns property tests", () => {
  it("P1: every human turn is present, and its output text equals its input text with STRIP_TAGS blocks stripped", () => {
    fc.assert(
      fc.property(turnsArb, (turns) => {
        const output = gutterTurns(turns);
        expect(output).toHaveLength(turns.length);
        for (let i = 0; i < turns.length; i++) {
          const turn = turns[i];
          if (turn?.role === "human") {
            expect(output[i]?.role).toBe("human");
            expect(output[i]?.text).toBe(stripTaggedNoise(turn.text));
          }
        }
      }),
    );
  });

  it("P2: guttered output is never longer than its input", () => {
    fc.assert(
      fc.property(turnsArb, (turns) => {
        const output = gutterTurns(turns);
        const inputTotal = turns.reduce((sum, t) => sum + inputTurnLength(t), 0);
        const outputTotal = output.reduce((sum, t) => sum + outputTurnLength(t), 0);
        expect(outputTotal).toBeLessThanOrEqual(inputTotal);
      }),
    );
  });
});
