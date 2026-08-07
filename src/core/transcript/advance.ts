// Pure per-line reducer for transcript ingestion — 02-ingestion.md "Parser
// requirements", 15-spec.md D3. The streaming reader (src/io/transcript/
// read.ts) owns the filesystem (read stream, readline) and feeds each raw
// line through advance(); this module owns every decision: counters,
// version tracking, warn-once-per-major, and what (if anything) to yield.
//
// PURE: no fs, no logging. advance() mutates the state object it's given
// and returns it — see the build task's design note: a persistent/
// immutable state structure is out of scope, only the decisions need to be
// pure and unit-testable.

import { parseLine, parseVersionMajor } from "./classify.js";
import type { TranscriptLine } from "../contracts/schema.js";

// Known envelope version majors. Local to this module (not constants.ts —
// see constants.ts header: it mirrors 13-constants.md, which has no
// schema-version row).
// eslint-disable-next-line signposts/no-magic-literal -- transcript envelope schema version major, not a 13-constants.md tunable
const KNOWN_VERSION_MAJORS = [2];

export interface TranscriptCounts {
  linesRead: number;
  /** Invalid JSON, or a known-type (user/assistant/system) line that failed its schema (R2). */
  linesSkipped: number;
  /** Valid JSON of a type ingestion doesn't handle (transcript sidecar records) — still yielded (R7/R8). */
  linesIgnored: number;
  versionsSeen: Set<string>;
}

/** State threaded through advance() across a transcript's lines (R1/R2). */
export interface TranscriptReadState {
  counts: TranscriptCounts;
  /** Version majors already warned about, so each unseen major warns once (R4). */
  warnedMajors: Set<number>;
}

/** Fresh state for the start of a transcript read. */
export function createTranscriptReadState(): TranscriptReadState {
  return {
    counts: {
      linesRead: 0,
      linesSkipped: 0,
      linesIgnored: 0,
      versionsSeen: new Set(),
    },
    warnedMajors: new Set(),
  };
}

export interface AdvanceResult {
  state: TranscriptReadState;
  /** Present when the line parsed (known type or unrecognised/ignored type) and should be yielded. */
  emit?: TranscriptLine;
  /** Present when this line's version major is newly unseen and should be logged once. */
  warn?: string;
}

/**
 * Applies one raw JSONL line to `state`: routes malformed/ignored/parsed
 * lines to the right counter, tracks the version (parsed and ignored lines
 * alike — R4 is unqualified by line type), and decides warn-once-per-major
 * and whether to yield. Mutates and returns `state` (R1).
 */
export function advance(state: TranscriptReadState, rawLine: string): AdvanceResult {
  state.counts.linesRead += 1;

  const result = parseLine(rawLine);
  if (result.status === "malformed") {
    state.counts.linesSkipped += 1;
    return { state };
  }

  // An ignored line's `version` is `unknown` under looseObject's catchall,
  // hence the typeof guard.
  const version = typeof result.line.version === "string" ? result.line.version : undefined;
  let warn: string | undefined;
  if (version !== undefined) {
    state.counts.versionsSeen.add(version);
    const major = parseVersionMajor(version);
    if (major !== undefined && !KNOWN_VERSION_MAJORS.includes(major) && !state.warnedMajors.has(major)) {
      state.warnedMajors.add(major);
      warn = `transcript version major ${major} is unseen (known: ${KNOWN_VERSION_MAJORS.join(", ")})`;
    }
  }

  if (result.status === "ignored") {
    state.counts.linesIgnored += 1;
  }

  return warn === undefined ? { state, emit: result.line } : { state, emit: result.line, warn };
}
