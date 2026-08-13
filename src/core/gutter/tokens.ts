// Token estimation for the gutter's output — 16-build-plan.md's repo
// layout lists "head/tail budgets, adjacency rule, token estimation" for
// gutter/. Feeds MIN_GUTTERED_TOKENS (constants.ts), the eligibility gate
// 02-ingestion.md's table states as "Content: >= 100 tokens post-gutter" —
// i.e. estimated over guttered output, not raw transcript input.
//
// ASSUMPTION: no exact token-estimate formula is documented in the spec
// docs. Using the standard chars/4 rule-of-thumb, per-string.

import type { GutteredTurn } from "./types.ts";

/** chars/4 rule-of-thumb estimate for one string. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Sums estimateTokens over a GutteredSession's turns' `.text` fields.
 * Deliberately text-only — toolNames/filesTouched are excluded from the
 * estimate.
 */
export function estimateGutteredSessionTokens(turns: GutteredTurn[]): number {
  return turns.reduce((sum, turn) => sum + estimateTokens(turn.text), 0);
}
