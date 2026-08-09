// Narrows `TranscriptLine.message.content` (contracts/schema.ts's
// z.unknown()) into the gutter's own GutterInputTurn shapes — the missing
// link between step 4 (transcript reader, src/io/transcript/read.ts) and
// step 5 (the gutter, gutter.ts). 12-wire-contracts.md: message.content is
// `string | ContentBlock[]`. Runtime narrowing of that unknown lives here,
// per types.ts's header comment and schema.ts's stated contract.
//
// Scope: turn-shape narrowing only. No GutteredSession assembly
// (repo/contentHash/session metadata) — that's a separate step that
// doesn't exist yet in this codebase, per gutter.ts's own header comment.

import { isHumanTurn } from "../transcript/classify.js";
import { TEXT_BLOCK_TYPE, TOOL_RESULT_BLOCK_TYPE, TOOL_USE_BLOCK_TYPE } from "../config/constants.js";
import type { AssistantLine, TranscriptLine, UserLine } from "../contracts/schema.js";
import type { AssistantGutterInputTurn, ContentBlock, GutterInputTurn, HumanGutterInputTurn } from "./types.js";

/**
 * Flattens `string | ContentBlock[]` content into one string. A plain
 * string is used as-is; an array of blocks concatenates the `text` blocks'
 * text, in order, dropping everything else (mirrors gutter.ts's
 * assistantText, but content here is unknown until narrowed, so each
 * element is checked at runtime rather than typed as ContentBlock).
 */
function flattenContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  let text = "";
  for (const block of content) {
    if (typeof block === "object" && block !== null && (block as { type?: unknown }).type === TEXT_BLOCK_TYPE) {
      const blockText = (block as { text?: unknown }).text;
      if (typeof blockText === "string") {
        text += blockText;
      }
    }
  }
  return text;
}

/**
 * Narrows one array element into a ContentBlock, or undefined if it isn't
 * one — text blocks require a string `text` (same check flattenContent
 * uses), so a malformed block (missing/non-string `text`) is dropped
 * instead of flowing `undefined`/a number into gutter.ts's `text +=
 * block.text`, which would fabricate content never in the transcript.
 * tool_use blocks require a string `id` and `name` (gutter.ts's
 * gutterAssistantTurn pushes `block.name` straight into toolNames — a
 * missing name would otherwise land as `toolNames: [undefined]`);
 * `input` stays unknown/unvalidated, same as tool_result's `content`.
 * tool_result blocks require a string `tool_use_id`; `content` stays
 * unknown/unvalidated. `thinking` blocks pass through as-is — gutter.ts
 * only reads fields off them once it has already narrowed on `.type`
 * itself (assistantText, extractFilePath).
 */
function toContentBlock(block: unknown): ContentBlock | undefined {
  if (typeof block !== "object" || block === null || typeof (block as { type?: unknown }).type !== "string") {
    return undefined;
  }
  const typed = block as { type: string; text?: unknown; id?: unknown; name?: unknown; tool_use_id?: unknown };
  if (typed.type === TEXT_BLOCK_TYPE) {
    return typeof typed.text === "string" ? { type: TEXT_BLOCK_TYPE, text: typed.text } : undefined;
  }
  if (typed.type === TOOL_USE_BLOCK_TYPE) {
    return typeof typed.id === "string" && typeof typed.name === "string" ? (block as ContentBlock) : undefined;
  }
  if (typed.type === TOOL_RESULT_BLOCK_TYPE) {
    return typeof typed.tool_use_id === "string" ? (block as ContentBlock) : undefined;
  }
  return block as ContentBlock;
}

/**
 * Narrows `unknown` content into ContentBlock[]. A plain string (e.g. bare
 * text content) becomes a single text block; an array is narrowed
 * element-by-element via toContentBlock, dropping malformed entries.
 */
function toContentBlocks(content: unknown): ContentBlock[] {
  if (typeof content === "string") {
    return [{ type: TEXT_BLOCK_TYPE, text: content }];
  }
  if (Array.isArray(content)) {
    return content.map(toContentBlock).filter((block): block is ContentBlock => block !== undefined);
  }
  return [];
}

/** Maps a UserLine already known (via isHumanTurn) to be a human turn. */
function toHumanGutterInputTurn(line: UserLine): HumanGutterInputTurn {
  return {
    role: "human",
    text: flattenContent(line.message?.content),
    at: line.timestamp,
  };
}

/** Maps an AssistantLine into its gutter input shape. */
function toAssistantGutterInputTurn(line: AssistantLine): AssistantGutterInputTurn {
  return {
    role: "assistant",
    blocks: toContentBlocks(line.message?.content),
    at: line.timestamp,
  };
}

/**
 * Routes one parsed TranscriptLine into a GutterInputTurn, or undefined for
 * anything gutterTurns() doesn't consume (non-human user lines, system/
 * other lines). Callers `.map()` a stream of TranscriptLine through this
 * and filter out `undefined` to get the ordered GutterInputTurn[]
 * gutterTurns() expects.
 */
export function toGutterInputTurn(line: TranscriptLine): GutterInputTurn | undefined {
  if (line.type === "user") {
    // Same non-narrowing union caveat classify.ts documents (OtherLine.type
    // is `string`, not a literal) — isHumanTurn takes the full
    // TranscriptLine and does its own check; the cast for the mapper is
    // sound once isHumanTurn has confirmed this is a UserLine.
    return isHumanTurn(line) ? toHumanGutterInputTurn(line as UserLine) : undefined;
  }
  if (line.type === "assistant") {
    return toAssistantGutterInputTurn(line as AssistantLine);
  }
  return undefined;
}
