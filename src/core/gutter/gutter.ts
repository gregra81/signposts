// The gutter (02-ingestion.md "The gutter", 15-spec.md D3): reduces a
// transcript's turns to the parts that carry human intent. PURE, no LLM
// call anywhere (R7) — heuristic head/tail truncation only.
//
// Scope: per-turn reduction only (turn in -> turn out). Assembling a full
// GutteredSession (repo/session metadata, tokenEstimate, redactionCount)
// and redaction itself are separate steps — 02-ingestion.md's "gutter
// first, redact second".

import {
  ASSISTANT_HEAD_CHARS,
  ASSISTANT_HEAD_CHARS_ADJACENT,
  ASSISTANT_HEAD_SENTENCES,
  ASSISTANT_TAIL_CHARS_ADJACENT,
  STRIP_TAGS,
} from "../config/constants.js";
import { head, headAndTail } from "./budget.js";
import type { AssistantGutterInputTurn, ContentBlock, GutterInputTurn, GutteredTurn } from "./types.js";

/**
 * Keys observed carrying a file path across tool_use inputs (Read/Write/
 * Edit use file_path; NotebookEdit uses notebook_path; Glob/Grep use path).
 * Checked in this order — first string value wins.
 */
const FILE_PATH_INPUT_KEYS = ["file_path", "notebook_path", "path"] as const;

function extractFilePath(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  for (const key of FILE_PATH_INPUT_KEYS) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

/**
 * Strips STRIP_TAGS-listed tagged blocks (`<tag>...</tag>`, non-greedy, all
 * occurrences) out of human text — slash-command noise and system-reminder
 * injections arriving as user text (02-ingestion.md), not part of what the
 * human actually said.
 */
export function stripTaggedNoise(text: string): string {
  let result = text;
  for (const tag of STRIP_TAGS) {
    result = result.replace(new RegExp(`<${tag}>.*?</${tag}>`, "gs"), "");
  }
  return result;
}

/**
 * Text of every `text` block, in order, concatenated so `head`/`headAndTail`
 * see one string. `thinking` and `tool_result` blocks are dropped entirely
 * (R6) simply by not being `text` — this narrowing on `block.type` is the
 * whole mechanism, not a separate filter. No separator inserted between
 * blocks — anything added here that isn't already in the source would
 * violate "guttered output is never longer than its input" (16-build-plan.md
 * P2).
 */
function assistantText(blocks: ContentBlock[]): string {
  let text = "";
  for (const block of blocks) {
    if (block.type === "text") {
      text += block.text;
    }
  }
  return text;
}

function gutterAssistantTurn(turn: AssistantGutterInputTurn, adjacentToHuman: boolean): GutteredTurn {
  const toolNames: string[] = [];
  const filePaths = new Set<string>();
  for (const block of turn.blocks) {
    if (block.type !== "tool_use") {
      continue;
    }
    toolNames.push(block.name); // name only — no arguments, no results (R4)
    const path = extractFilePath(block.input);
    if (path !== undefined) {
      filePaths.add(path);
    }
  }
  const filesTouched = [...filePaths];

  const source = assistantText(turn.blocks);
  const text = adjacentToHuman
    ? headAndTail(source, ASSISTANT_HEAD_CHARS_ADJACENT, ASSISTANT_TAIL_CHARS_ADJACENT)
    : head(source, ASSISTANT_HEAD_SENTENCES, ASSISTANT_HEAD_CHARS);

  return {
    role: "assistant",
    text,
    at: turn.at,
    ...(toolNames.length > 0 ? { toolNames } : {}),
    ...(filesTouched.length > 0 ? { filesTouched } : {}),
  };
}

/**
 * Reduces one ordered sequence of turns. Human turns pass through as-is
 * apart from STRIP_TAGS noise removal (R1, B2 fix) — slash-command
 * stdout/caveat/system-reminder tags a human never typed. Assistant turns
 * get a trimmed head, or — for the turn immediately preceding a human
 * turn — a larger head-plus-tail budget (R3), because the human's reply
 * usually answers the end of that turn, not just its opening.
 */
export function gutterTurns(turns: GutterInputTurn[]): GutteredTurn[] {
  return turns.map((turn, index) => {
    if (turn.role === "human") {
      return { role: "human", text: stripTaggedNoise(turn.text), at: turn.at };
    }
    const adjacentToHuman = turns[index + 1]?.role === "human";
    return gutterAssistantTurn(turn, adjacentToHuman);
  });
}
