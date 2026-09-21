// The user turn for each of the graph's four LLM nodes, transcribed from
// 14-prompts.md's "### User" blocks.
//
// Everything that varies per run lives here and nowhere else. The system
// prompts in ./system.ts must stay byte-identical across every call to keep
// the cache prefix intact (08-models-and-credentials.md), so the repo name,
// the transcript, the candidates and the critique all belong in this turn —
// test/invariant/prompt-stability.test.ts is the mechanical check on that
// split.
//
// PURE string building. JSON is rendered compactly and with no interpolated
// whitespace, so a replayed fixture keys on exactly the bytes it was recorded
// with (src/io/model/fixture-provider.ts keys on the user turn).

import { CONVENTIONS_FILENAME } from "../config/constants.ts";
import type { Candidate, NeighbourSignpost } from "../contracts/graph.ts";
import type { Signpost } from "../signpost/schema.ts";

function renderJson(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Appended when `critique` is present — the reflection loop's way of telling
 * `extract` what the critic objected to. 14-prompts.md's "Retry" block.
 */
export const EXTRACT_RETRY_PREAMBLE =
  "A previous attempt was reviewed and most candidates were rejected:";

/**
 * Heads the claims the critic kept, inside the critique. The retry instruction
 * says "be stricter" and names only what failed, so without this a retry
 * returned nothing and the one claim the critic had kept was lost with the
 * batch (19-value-to-a-user.md, "Follow-up: scenario 007").
 */
export const CRITIQUE_KEPT_PREAMBLE =
  "These were kept. Return each of them again, unchanged, and apply the stricter test only to the rest:";

export const EXTRACT_RETRY_INSTRUCTION =
  "Try again. Be stricter. If nothing survives the test, return an empty list.";

/**
 * Appended when the self-correction loop sends the batch back — the errors
 * `validate` produced, so the regeneration knows what was malformed.
 *
 * Without this the retry was a wasted call: the prompt came back byte-identical
 * to the one that produced the invalid operation, so the model had no reason
 * to answer differently and the candidate was dropped on the next pass anyway.
 */
export const EXTRACT_INVALID_PREAMBLE =
  "A previous attempt produced operations that failed validation:";

export interface ExtractUserTurnInput {
  repo: string;
  /** The re-derived guttered transcript. Never read from state — see 12-wire-contracts.md. */
  guttered: string;
  /** Present only on a retry through the reflection loop. */
  critique?: string | undefined;
  /** Present only on a retry through the self-correction loop. */
  validationErrors?: readonly string[] | undefined;
}

export function extractUserTurn({
  repo,
  guttered,
  critique,
  validationErrors,
}: ExtractUserTurnInput): string {
  const sections = [`Repository: ${repo}\n\nTranscript:\n${guttered}`];

  if (critique !== undefined) {
    sections.push(`${EXTRACT_RETRY_PREAMBLE}\n\n${critique}`);
  }
  if (validationErrors !== undefined && validationErrors.length > 0) {
    sections.push(`${EXTRACT_INVALID_PREAMBLE}\n\n${formatValidationErrors(validationErrors)}`);
  }
  if (sections.length === 1) {
    return sections[0] as string;
  }

  sections.push(EXTRACT_RETRY_INSTRUCTION);
  return sections.join("\n\n");
}

/** One line per error, in the order `validate` reported them. */
export function formatValidationErrors(errors: readonly string[]): string {
  return errors.map((error) => `- ${error}`).join("\n");
}

/**
 * What the critic judges. `conventions` is the repo's own conventions file,
 * already capped by the port that read it, and absent for a repo that has
 * none — see ConventionsPort and CRITIC_CONVENTIONS_MAX_CHARS.
 */
export function criticUserTurn(
  repo: string,
  candidates: readonly Candidate[],
  conventions?: string,
): string {
  const turn = `Repository: ${repo}\n\nCandidates:\n${renderJson(candidates)}`;
  return conventions === undefined || conventions === ""
    ? turn
    : `${turn}\n\nAlready written down in this repository (${CONVENTIONS_FILENAME}, truncated):\n${conventions}`;
}

export function classifyUserTurn(candidate: Candidate, neighbours: readonly NeighbourSignpost[]): string {
  return `Candidate:\n${renderJson(candidate)}\n\nExisting neighbours:\n${renderJson(neighbours)}`;
}

export function resolveUserTurn(
  repo: string,
  candidate: Candidate,
  existing: Signpost,
): string {
  return `Repository: ${repo}\n\nNew claim:\n${renderJson(candidate)}\n\nExisting claim:\n${renderJson(existing)}`;
}

/**
 * The critique fed back to `extract`: one line per rejected candidate, naming
 * the claim and the critic's reason, then the kept claims under their own
 * preamble.
 *
 * The kept ones are there because the retry replaces the batch wholesale. An
 * earlier version sent rejections only, to save tokens, and a retry told to be
 * stricter dropped the kept claim with the rest. With nothing kept the output
 * is byte-identical to that version, so fixtures on that path still replay.
 */
export function formatCritique(
  rejected: ReadonlyArray<{ claim: string; reason: string }>,
  kept: readonly string[] = [],
): string {
  const rejections = rejected.map(({ claim, reason }) => `- ${claim}\n  rejected: ${reason}`).join("\n");
  if (kept.length === 0) {
    return rejections;
  }
  return `${rejections}\n\n${CRITIQUE_KEPT_PREAMBLE}\n\n${kept.map((claim) => `- ${claim}`).join("\n")}`;
}
