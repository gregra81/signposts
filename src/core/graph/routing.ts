// The two bounded loops of 04-extraction-graph.md, as pure decisions.
//
// Both are bounded at 2 attempts (MAX_EXTRACT_ATTEMPTS,
// MAX_VALIDATE_ATTEMPTS) and both fail *open*: when the budget is spent the
// run continues with whatever survived, dropping the offending items. Neither
// loop can fail the run, and neither can spin — "an unbounded reflection loop
// is the classic way to burn a budget overnight".
//
// PURE: counts and verdicts in, a routing word out. The graph edges in
// src/graph/ do nothing but call these and map the word to a node name.

import {
  CRITIC_REJECT_RATIO,
  MAX_EXTRACT_ATTEMPTS,
  MAX_VALIDATE_ATTEMPTS,
} from "../config/constants.ts";
import type { CriticVerdict } from "../contracts/graph.ts";

// ---------------------------------------------------------------------------
// Reflection loop: critic -> extract
// ---------------------------------------------------------------------------

export type CriticRoute = "retry-extract" | "continue";

export interface CriticRouteInput {
  verdicts: readonly CriticVerdict[];
  /** How many times `extract` has already run, including the run just critiqued. */
  extractAttempts: number;
}

/**
 * Fraction of verdicts that rejected. Zero verdicts is 0, not NaN: `extract`
 * legitimately returns nothing ("Extracting nothing is a correct and common
 * outcome"), and there is nothing to reject in an empty batch — re-running
 * extraction on a transcript that yielded no candidates would just spend the
 * budget to get the same empty list.
 */
export function rejectRatio(verdicts: readonly CriticVerdict[]): number {
  if (verdicts.length === 0) {
    return 0;
  }
  const rejected = verdicts.filter((verdict) => !verdict.keep).length;
  return rejected / verdicts.length;
}

/**
 * Route back to `extract` with the critique attached only when the critic
 * rejected more than CRITIC_REJECT_RATIO of the batch AND the attempt budget
 * is not spent. Otherwise continue with the survivors — which, when the
 * budget IS spent, is the "drop and continue" outcome rather than a failure.
 */
export function criticRoute({ verdicts, extractAttempts }: CriticRouteInput): CriticRoute {
  const overRejected = rejectRatio(verdicts) > CRITIC_REJECT_RATIO;
  return overRejected && extractAttempts < MAX_EXTRACT_ATTEMPTS ? "retry-extract" : "continue";
}

// ---------------------------------------------------------------------------
// Self-correction loop: validate -> extract
// ---------------------------------------------------------------------------

export type ValidateRoute = "retry-extract" | "drop-invalid" | "continue";

export interface ValidateRouteInput {
  /** One entry per operation that failed schema-lint. Empty means everything passed. */
  validationErrors: readonly string[];
  /** How many times `validate` has already run. */
  validateAttempts: number;
}

/**
 * Three outcomes, not two. "drop-invalid" is the branch that keeps a single
 * bad candidate from failing the whole run: the budget is spent, so the
 * offending operations are dropped and the valid ones carry on to the gate.
 */
export function validateRoute({
  validationErrors,
  validateAttempts,
}: ValidateRouteInput): ValidateRoute {
  if (validationErrors.length === 0) {
    return "continue";
  }
  return validateAttempts < MAX_VALIDATE_ATTEMPTS ? "retry-extract" : "drop-invalid";
}
