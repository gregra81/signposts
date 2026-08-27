// Pure post-processing between the graph's LLM nodes: what `extract`'s raw
// output becomes before it is checkpointed, and what survives `critic`.
//
// Kept out of the node bodies in src/graph/ deliberately — these are the
// policy decisions (the hedge cap, the per-session backstop, "may only
// lower") that mutation testing should grade, and src/graph/ is not graded.

import { HEDGE_CONFIDENCE_CAP, MAX_CANDIDATES_PER_SESSION } from "../config/constants.ts";
import type { Candidate, CriticVerdict } from "../contracts/graph.ts";

/**
 * Caps a hedged candidate's confidence at HEDGE_CONFIDENCE_CAP
 * (12-wire-contracts.md's `hedged` field). The model reports whether the
 * human hedged; the cap is our policy on top of that, applied here so it
 * cannot be forgotten at a call site.
 *
 * The cap sits below AUTO_PUBLISH_CONFIDENCE by construction, so a hedged
 * claim can never auto-publish — it routes to a person, which is the right
 * home for someone else's stated uncertainty.
 */
export function applyHedgeCap(candidate: Candidate): Candidate {
  if (!candidate.hedged || candidate.confidence <= HEDGE_CONFIDENCE_CAP) {
    return candidate;
  }
  return { ...candidate, confidence: HEDGE_CONFIDENCE_CAP };
}

/**
 * Everything `extract`'s output goes through before it reaches state: the
 * hedge cap, then MAX_CANDIDATES_PER_SESSION as a backstop against runaway
 * extraction. The backstop truncates rather than failing — a model that
 * returned fifty candidates has misread the transcript, and the first N are
 * no worse than the last N.
 */
export function acceptCandidates(candidates: readonly Candidate[]): Candidate[] {
  return candidates.slice(0, MAX_CANDIDATES_PER_SESSION).map(applyHedgeCap);
}

/**
 * The candidates `critic` kept, with any confidence adjustment applied.
 *
 * `adjustedConfidence` "may only lower" (12-wire-contracts.md), and that is
 * enforced here rather than trusted: a critic that raises confidence would be
 * promoting its own judgment over the extractor's evidence, and the gate
 * downstream reads confidence as the auto-publish key.
 *
 * A candidate with no verdict is dropped. The critic is asked about every
 * candidate; silence about one is a missing answer, not tacit approval.
 */
export function survivors(
  candidates: readonly Candidate[],
  verdicts: readonly CriticVerdict[],
): Candidate[] {
  const byTempId = new Map(verdicts.map((verdict) => [verdict.tempId, verdict]));

  const kept: Candidate[] = [];
  for (const candidate of candidates) {
    const verdict = byTempId.get(candidate.tempId);
    if (verdict === undefined || !verdict.keep) {
      continue;
    }
    kept.push(applyAdjustment(candidate, verdict.adjustedConfidence));
  }
  return kept;
}

function applyAdjustment(candidate: Candidate, adjusted: number | undefined): Candidate {
  if (adjusted === undefined || adjusted >= candidate.confidence) {
    return candidate;
  }
  return { ...candidate, confidence: adjusted };
}
