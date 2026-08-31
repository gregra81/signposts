// Assembles a whole GutteredSession from a transcript on disk — the step
// src/core/gutter/types.ts calls out as deliberately absent from Slice A
// ("no GutteredSession assembly"). Everything it composes already exists and
// is already proven: this file only orders those steps and adds the two
// facts that need the file itself, the content hash and the timestamps.
//
// The order is 02-ingestion.md's, and it is not interchangeable: read ->
// gutter -> redact. Redacting first would spend the redactor on assistant
// text the gutter is about to throw away, and — worse — would let a secret
// survive inside a head/tail budget that was measured before redaction
// changed the length.
//
// Redaction is fail-closed (safeRedact): a redactor that throws means this
// transcript is skipped entirely, never sent with partial redaction applied.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { gutterTurns } from "../../core/gutter/gutter.ts";
import { toGutterInputTurn } from "../../core/gutter/input.ts";
import { estimateGutteredSessionTokens } from "../../core/gutter/tokens.ts";
import { safeRedact } from "../../core/redact/redact.ts";
import { readTranscript } from "../transcript/read.ts";
import { KNOWN_LINE_TYPES } from "../../core/contracts/schema.ts";
import type { Envelope, TranscriptLine } from "../../core/contracts/schema.ts";
import type { GutterInputTurn, GutteredSession, GutteredTurn } from "../../core/gutter/types.ts";

/**
 * The envelope fields, for the lines that actually carry one.
 *
 * `otherLineSchema` is a bare `{ type: string }` catch-all over sidecar
 * records that carry no uuid or timestamp at all, so reading `sessionId` off
 * an unnarrowed TranscriptLine is reading a field that may not exist. Routing
 * on KNOWN_LINE_TYPES — the same set the catch-all excludes — is what makes
 * the cast sound.
 */
function envelopeOf(line: TranscriptLine): Envelope | undefined {
  return KNOWN_LINE_TYPES.has(line.type) ? (line as Envelope) : undefined;
}

/** The two facts the transcript cannot supply — the caller knows where it came from. */
export interface SessionScope {
  repo: string;
  repoRoot: string;
}

/** sha256 of the raw file, streamed: the same dedup key `thread-id.ts` builds on. */
async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

/**
 * Redacts every turn's text, and reports how many turns it changed.
 *
 * "Turns changed" rather than "secrets found" because a Redactor returns
 * text, not a match count — and the number only exists to be logged, never
 * to gate anything, so the cheaper definition is the honest one.
 */
function redactTurns(turns: GutteredTurn[]): { turns: GutteredTurn[]; redactionCount: number } {
  let redactionCount = 0;
  const redacted = turns.map((turn) => {
    const result = safeRedact(turn.text);
    if (!result.ok) {
      throw new Error("redaction failed — transcript skipped rather than sent partially redacted");
    }
    if (result.text !== turn.text) {
      redactionCount += 1;
    }
    return { ...turn, text: result.text };
  });
  return { turns: redacted, redactionCount };
}

export async function gutterSession(
  transcriptPath: string,
  scope: SessionScope,
): Promise<GutteredSession> {
  const inputTurns: GutterInputTurn[] = [];
  let sessionId: string | undefined;
  let branch: string | undefined;
  let startedAt: string | undefined;
  let lastActivityAt: string | undefined;

  const { lines } = readTranscript(transcriptPath);
  for await (const line of lines) {
    const envelope = envelopeOf(line);
    if (envelope === undefined) {
      continue;
    }
    // 12-wire-contracts.md: `isSidechain` true is a subagent line, skipped in
    // v1. It is dropped here rather than in gutterTurns() because the flag
    // lives on the envelope, which the per-turn reducer never sees.
    if (envelope.isSidechain === true) {
      continue;
    }

    sessionId ??= envelope.sessionId;
    branch ??= envelope.gitBranch;
    // The reader yields lines in file order, so the first and last timestamps
    // seen are the session's bounds — no sorting, no Date parsing.
    startedAt ??= envelope.timestamp;
    lastActivityAt = envelope.timestamp;

    const turn = toGutterInputTurn(line);
    if (turn !== undefined) {
      inputTurns.push(turn);
    }
  }

  if (sessionId === undefined || startedAt === undefined || lastActivityAt === undefined) {
    throw new Error(`${transcriptPath}: no usable transcript lines`);
  }

  const { turns, redactionCount } = redactTurns(gutterTurns(inputTurns));

  return {
    sessionId,
    contentHash: await hashFile(transcriptPath),
    repo: scope.repo,
    repoRoot: scope.repoRoot,
    ...(branch === undefined ? {} : { branch }),
    startedAt,
    lastActivityAt,
    turns,
    tokenEstimate: estimateGutteredSessionTokens(turns),
    redactionCount,
  };
}
