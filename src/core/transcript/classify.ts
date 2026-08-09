// Human-turn classification and the pure line-parsing step for transcript
// ingestion — 02-ingestion.md "Classifying `user` lines — the critical
// rule", 15-spec.md D3. Only ~6% of `user` lines are a human speaking (206
// of 3532, measured across 105 transcripts); the rest are tool results and
// slash-command noise wearing a user hat.
// `origin.kind === "human"` is the load-bearing check — without it,
// slash-command stdout (an ordinary `user` line with plain-string content
// and no `origin` at all) reads as human text to a naive parser.
//
// PURE: no fs, no logging. read.ts calls advance(), which calls parseLine
// per line; isHumanTurn is exported for callers to run per line.

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
 * transcriptLineSchema. Never throws.
 *
 * Three outcomes, not two — "malformed" and "unrecognised type" are
 * different things (02-ingestion.md "Parser requirements"): invalid JSON,
 * or a known-type (user/assistant/system) line that fails its schema, is
 * "malformed". A valid-JSON line with a type ingestion doesn't handle
 * (transcript sidecar records like "mode", "ai-title") is "ignored" — it
 * parsed fine, we just don't do anything with it.
 */
export function parseLine(raw: string): ParseLineResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    // json stays undefined; safeParse below rejects it same as any other
    // malformed input, so there is nothing distinct to do here.
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
 * True iff line is a user line with origin.kind === "human". Used to be
 * four rules (isMeta, toolUseResult presence, all-blocks-tool_result
 * content, origin.kind) — measured across 105 transcripts / 3532 user
 * lines, the other three never rejected a line that origin.kind didn't
 * already reject, so they were dead weight. origin.kind alone is the
 * load-bearing check.
 */
export function isHumanTurn(line: TranscriptLine): boolean {
  // `TranscriptLine` is a plain union (OtherLine.type is `string`, not a
  // literal — see contracts/schema.ts), so `line.type === "user"` alone
  // does not narrow away OtherLine. The cast is sound: otherLineSchema
  // fatally rejects the three known type tags, so a line with
  // type === "user" can only have come from userLineSchema — the same
  // argument parseLine's casts rely on.
  return line.type === "user" && (line as UserLine).origin?.kind === "human";
}
