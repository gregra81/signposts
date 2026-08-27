// Pure per-line reducer for transcript ingestion — 02-ingestion.md "Parser
// requirements", 15-spec.md D3. The streaming reader (src/io/transcript/
// read.ts) owns the filesystem (read stream, readline) and feeds each raw
// line through advance(); this module owns every decision: the counters
// and what (if anything) to yield.
//
// NO IO: no fs, no logging. advance() mutates the state object it's given —
// see the build task's design note: a persistent/immutable state structure
// is out of scope, only the decisions need to be pure and unit-testable.

import { parseLine } from "./classify.ts";
import type { TranscriptLine } from "../contracts/schema.ts";

export interface TranscriptCounts {
  linesRead: number;
  /** Invalid JSON, or a known-type (user/assistant/system) line that failed its schema. */
  linesSkipped: number;
  /** Valid JSON of a type ingestion doesn't handle (transcript sidecar records) — still yielded. */
  linesIgnored: number;
}

/** State threaded through advance() across a transcript's lines. */
export interface TranscriptReadState {
  counts: TranscriptCounts;
}

/** Fresh state for the start of a transcript read. */
export function createTranscriptReadState(): TranscriptReadState {
  return {
    counts: {
      linesRead: 0,
      linesSkipped: 0,
      linesIgnored: 0,
    },
  };
}

/**
 * Applies one raw JSONL line to `state`: routes malformed/ignored/parsed
 * lines to the right counter, and decides whether to yield. Mutates
 * `state`. Returns the line to yield, or undefined for a malformed line.
 */
export function advance(state: TranscriptReadState, rawLine: string): TranscriptLine | undefined {
  state.counts.linesRead += 1;

  const result = parseLine(rawLine);
  if (result.status === "malformed") {
    state.counts.linesSkipped += 1;
    return undefined;
  }

  if (result.status === "ignored") {
    state.counts.linesIgnored += 1;
  }

  return result.line;
}
