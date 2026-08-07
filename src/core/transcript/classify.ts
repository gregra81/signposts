// Human-turn classification and the pure line-parsing step for transcript
// ingestion — 02-ingestion.md "Classifying `user` lines — the critical
// rule", 15-spec.md D3. Only ~1/3 of `user` lines are a human speaking; the
// rest are tool results and slash-command noise wearing a user hat.
// `origin.kind === "human"` is the load-bearing check — without it,
// slash-command stdout (an ordinary `user` line with plain-string content
// and no `origin` at all) reads as human text to a naive parser.
//
// PURE: no fs, no logging. The streaming reader (src/io/transcript/read.ts)
// calls parseLine per line; isHumanTurn is exported for callers to run per
// user line.

import {
  KNOWN_LINE_TYPES,
  transcriptLineSchema,
  type AssistantLine,
  type OtherLine,
  type SystemLine,
  type TranscriptLine,
  type UserLine,
} from "../contracts/schema.js";
import { DROP_BLOCK_TYPES } from "../config/constants.js";

// Same wire-format block type tag as the gutter's drop list in constants.ts.
const TOOL_RESULT_BLOCK_TYPE: "tool_result" = DROP_BLOCK_TYPES[1];

// ---------------------------------------------------------------------------
// Line parsing
// ---------------------------------------------------------------------------

export type ParseLineResult =
  | { status: "parsed"; line: UserLine | AssistantLine | SystemLine }
  | { status: "ignored"; line: OtherLine }
  | { status: "malformed" };

/**
 * Parses one JSONL line: JSON.parse then validate against
 * transcriptLineSchema. Never throws (R2/R6).
 *
 * Three outcomes, not two — "malformed" and "unrecognised type" are
 * different things (R2/R7): invalid JSON, or a known-type (user/assistant/
 * system) line that fails its schema, is "malformed". A valid-JSON line
 * with a type ingestion doesn't handle (transcript sidecar records like
 * "mode", "ai-title") is "ignored" — it parsed fine, we just don't do
 * anything with it.
 */
export function parseLine(raw: string): ParseLineResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { status: "malformed" };
  }

  const result = transcriptLineSchema.safeParse(json);
  if (!result.success) {
    return { status: "malformed" };
  }
  if (KNOWN_LINE_TYPES.has(result.data.type)) {
    return { status: "parsed", line: result.data as UserLine | AssistantLine | SystemLine };
  }
  return { status: "ignored", line: result.data as OtherLine };
}

// ---------------------------------------------------------------------------
// Human-turn classification
// ---------------------------------------------------------------------------

function isToolResultBlock(block: unknown): boolean {
  return (
    typeof block === "object" &&
    block !== null &&
    "type" in block &&
    (block as { type: unknown }).type === TOOL_RESULT_BLOCK_TYPE
  );
}

/**
 * Narrows a TranscriptLine to a UserLine by discriminating on `type`.
 * `TranscriptLine` is a plain union (OtherLine.type is `string`, not a
 * literal — see contracts/schema.ts), so `line.type === "user"` alone does
 * not narrow away OtherLine. Callers of readTranscript need this to reach
 * isHumanTurn, which only accepts UserLine.
 */
export function isUserLine(line: TranscriptLine): line is UserLine {
  return line.type === "user";
}

/**
 * Returns false when: isMeta is true; toolUseResult is present;
 * message.content is an array whose blocks are all tool_result; or
 * origin.kind !== "human". Otherwise true. An empty content array is
 * vacuously "every block is tool_result" (Array.prototype.every on []
 * is true) and origin.kind !== "human" would also reject it — either way
 * an empty content array is never a human turn.
 */
export function isHumanTurn(line: UserLine): boolean {
  if (line.isMeta) {
    return false;
  }
  if (line.toolUseResult !== undefined) {
    return false;
  }
  const content = line.message?.content;
  if (Array.isArray(content) && content.every(isToolResultBlock)) {
    return false;
  }
  if (line.origin?.kind !== "human") {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Version tracking
// ---------------------------------------------------------------------------

/**
 * Extracts the leading integer of a version string (e.g. "2.1.223" -> 2).
 * Returns undefined when version is absent or doesn't start with an
 * integer — that is not a warning condition, just not a recorded major.
 */
export function parseVersionMajor(version: string | undefined): number | undefined {
  if (version === undefined) {
    return undefined;
  }
  const match = /^(\d+)/.exec(version);
  if (!match) {
    return undefined;
  }
  return Number(match[1]);
}
