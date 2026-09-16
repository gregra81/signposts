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
//
// It uses wireRedactors(repoRoot), not defaultRedactors(): this is the first
// module that assembles a GutteredSession and hands it to a model, so it is
// where 02-ingestion.md's "Nothing leaves the machine unredacted" becomes
// reachable, email pseudonymisation included. `filesTouched` goes through the
// same pass — those are absolute paths lifted verbatim out of `tool_use`
// inputs, and a path is as capable of carrying a secret or a person's name as
// the prose around it. They are made repo-relative first
// (src/core/redact/paths.ts): that is what removes the home directory, and it
// leaves behind exactly the path `scope.paths` and `pathOverlapBoost` are
// built from.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { UnusableTranscriptError } from "../../core/errors/unusable-transcript.ts";
import { gutterTurns } from "../../core/gutter/gutter.ts";
import { toGutterInputTurn } from "../../core/gutter/input.ts";
import { estimateGutteredSessionTokens } from "../../core/gutter/tokens.ts";
import { repoRelativePath } from "../../core/redact/paths.ts";
import { safeRedact, wireRedactors } from "../../core/redact/redact.ts";
import { readTranscript } from "../transcript/read.ts";
import { KNOWN_LINE_TYPES } from "../../core/contracts/schema.ts";
import type { Envelope, TranscriptLine } from "../../core/contracts/schema.ts";
import type { GutterInputTurn, GutteredSession, GutteredTurn } from "../../core/gutter/types.ts";
import type { Redactor } from "../../core/redact/types.ts";

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

/** One string through the fail-closed boundary, or a throw that skips the transcript. */
function redactOne(text: string, redactors: readonly Redactor[]): string {
  const result = safeRedact(text, redactors);
  if (!result.ok) {
    throw new UnusableTranscriptError("redaction failed on this transcript — nothing was sent partially redacted");
  }
  return result.text;
}

/**
 * Redacts every turn's text and file paths, and reports how many turns it
 * changed.
 *
 * "Turns changed" rather than "secrets found" because a Redactor returns
 * text, not a match count — and the number only exists to be logged, never
 * to gate anything, so the cheaper definition is the honest one. A turn whose
 * only change was to a path counts the same as one whose prose changed:
 * both mean something in that turn would have left the machine raw.
 *
 * `toolNames` is left alone. They are tool names from a fixed vocabulary —
 * Read, Bash, Edit — with nothing user-supplied in them to redact.
 */
function redactTurns(
  turns: GutteredTurn[],
  redactors: readonly Redactor[],
  repoRoot: string,
): { turns: GutteredTurn[]; redactionCount: number } {
  let redactionCount = 0;
  const redacted = turns.map((turn) => {
    const text = redactOne(turn.text, redactors);
    const filesTouched = turn.filesTouched?.map((file) =>
      redactOne(repoRelativePath(file, repoRoot), redactors),
    );
    if (text !== turn.text || filesTouched?.some((file, i) => file !== turn.filesTouched?.[i]) === true) {
      redactionCount += 1;
    }
    return { ...turn, text, ...(filesTouched === undefined ? {} : { filesTouched }) };
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
    throw new UnusableTranscriptError(`${transcriptPath}: no usable transcript lines`);
  }

  const { turns, redactionCount } = redactTurns(
    gutterTurns(inputTurns),
    wireRedactors(scope.repoRoot),
    scope.repoRoot,
  );

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
