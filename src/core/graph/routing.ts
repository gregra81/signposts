// The two bounded loops of 04-extraction-graph.md, as pure decisions.
//
// Each loop has its own budget and each fails *open*: when the budget is spent
// the run continues with whatever survived, dropping the offending items.
// Neither loop can fail the run, and neither can spin — "an unbounded
// reflection loop is the classic way to burn a budget overnight".
//
// The budgets are per loop, not per run, and they are counted in *retries
// issued* rather than in `extract` runs. Counting extract runs conflated them:
// a self-correction retry pushed the shared counter past MAX_EXTRACT_ATTEMPTS,
// after which the critic's verdict was ignored on every later pass even though
// the reflection loop had never sent anything back. Worst case is therefore
// three `extract` runs — the first, one reflection retry, one self-correction
// retry — and that is the bound.
//
// PURE: counts and verdicts in, a routing word out. The graph edges in
// src/graph/ do nothing but call these and map the word to a node name.

import {
  CRITIC_REJECT_RATIO,
  MAX_EXTRACT_ATTEMPTS,
  MAX_VALIDATE_ATTEMPTS,
} from "../config/constants.ts";
import type { Candidate, CriticVerdict } from "../contracts/graph.ts";

// ---------------------------------------------------------------------------
// Reflection loop: critic -> extract
// ---------------------------------------------------------------------------

export type CriticRoute = "retry-extract" | "continue";

export interface CriticRouteInput {
  /** Everything `extract` produced — the batch the critic was asked about. */
  candidates: readonly Candidate[];
  verdicts: readonly CriticVerdict[];
  /** How many times this loop has already sent the batch back to `extract`. */
  criticRetries: number;
}

/**
 * Fraction of the batch the critic did not keep.
 *
 * The denominator is the candidate count, not the verdict count. A candidate
 * the critic never answered is dropped by `survivors` — "silence about one is
 * a missing answer, not tacit approval" — so counting only the answers made a
 * truncated reply indistinguishable from a clean one: one keep verdict for
 * five candidates scored 0, continued, and four good candidates disappeared
 * with no retry and nothing logged. An unanswered candidate is not kept, so it
 * belongs in the numerator with the rejected ones.
 *
 * Zero candidates is 0, not NaN: `extract` legitimately returns nothing
 * ("Extracting nothing is a correct and common outcome"), and re-running
 * extraction on a transcript that yielded no candidates would just spend the
 * budget to get the same empty list.
 */
export function rejectRatio(
  candidates: readonly Candidate[],
  verdicts: readonly CriticVerdict[],
): number {
  if (candidates.length === 0) {
    return 0;
  }
  const keptTempIds = new Set(
    verdicts.filter((verdict) => verdict.keep).map((verdict) => verdict.tempId),
  );
  const kept = candidates.filter((candidate) => keptTempIds.has(candidate.tempId)).length;
  return (candidates.length - kept) / candidates.length;
}

/**
 * Route back to `extract` with the critique attached only when the critic
 * kept less than CRITIC_REJECT_RATIO of the batch AND this loop's retry budget
 * is not spent. Otherwise continue with the survivors — which, when the
 * budget IS spent, is the "drop and continue" outcome rather than a failure.
 */
export function criticRoute({
  candidates,
  verdicts,
  criticRetries,
}: CriticRouteInput): CriticRoute {
  const overRejected = rejectRatio(candidates, verdicts) > CRITIC_REJECT_RATIO;
  return overRejected && criticRetries < MAX_EXTRACT_ATTEMPTS - 1 ? "retry-extract" : "continue";
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
