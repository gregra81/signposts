// Human-turn classification and the pure line-parsing step for transcript
// ingestion — 02-ingestion.md "Classifying `user` lines — the critical
// rule", 15-spec.md D3. Only ~6% of `user` lines are a human speaking (206
// of 3532, measured across 105 transcripts); the rest are tool results and
// slash-command noise wearing a user hat.
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
 * True iff origin.kind is "human". Used to be four rules (isMeta,
 * toolUseResult presence, all-blocks-tool_result content, origin.kind) —
 * measured across 105 transcripts / 3532 user lines, the other three never
 * rejected a line that origin.kind didn't already reject, so they were
 * dead weight. origin.kind alone is the load-bearing check.
 */
export function isHumanTurn(line: UserLine): boolean {
  return line.origin?.kind === "human";
}
