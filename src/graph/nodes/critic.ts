// Node 3, `critic` — LLM. The reflection loop's judge.
//
// Input is candidates only: small, cheap, and deliberately without the
// transcript, so it judges the claims rather than re-reading the session that
// produced them. 14-prompts.md keeps it a separate call for the same reason —
// it must judge without having authored anything.
//
// The node applies the pure decision in src/core/graph/routing.ts and records
// its result in state: a critique present means "go back to `extract`". The
// bound lives inside `criticRoute`, so the edge that reads this cannot get it
// wrong, and an exhausted budget simply continues with the survivors rather
// than failing the run.
//
// `criticRetries` is this loop's own budget, incremented here at the point the
// retry is issued. It is deliberately not `extractAttempts`: the
// self-correction loop re-runs `extract` too, and sharing the counter let a
// validate retry spend the critic's budget without the critic ever having
// sent anything back.

import { criticRoute } from "../../core/graph/routing.ts";
import { survivors } from "../../core/graph/candidates.ts";
import { criticUserTurn, formatCritique } from "../../core/prompts/user-turns.ts";
import { callStructured } from "../llm.ts";
import type { CriticVerdict } from "../../core/contracts/graph.ts";
import type { ExtractionState, ExtractionUpdate } from "../state.ts";
import type { GraphPorts } from "../ports.ts";

export function makeCriticNode(ports: GraphPorts) {
  return async function criticNode(state: ExtractionState): Promise<ExtractionUpdate> {
    // What the repo already writes down, so "inferable from the documentation"
    // is a rule the critic can actually apply (19-value-to-a-user.md, the
    // critic-precision follow-up). A repo with no conventions file reads the
    // same as one this run cannot see: the candidates alone.
    const conventions = (await ports.conventions?.read()) ?? undefined;
    const { verdicts } = await callStructured({
      model: ports.model,
      node: "critic",
      user: criticUserTurn(state.repo, state.candidates, conventions),
    });

    const route = criticRoute({
      candidates: state.candidates,
      verdicts,
      criticRetries: state.criticRetries,
    });

    if (route === "retry-extract") {
      // Candidates are left untouched: they are about to be replaced wholesale
      // by the retry, and narrowing them here would only shrink what a second
      // rejection has to work with. The ones the critic kept travel in the
      // critique instead.
      return {
        critique: rejectionCritique(state.candidates, verdicts),
        criticRetries: state.criticRetries + 1,
      };
    }

    return { candidates: survivors(state.candidates, verdicts), critique: undefined };
  };
}

/**
 * The critique the retry carries: one line per candidate the critic did not
 * keep, defined the same way `rejectRatio` defines rejection, then the claims
 * it did keep, so the retry returns them instead of losing them with the batch.
 *
 * Walking the candidates rather than the verdicts is what keeps the two in
 * step. A truncated reply — one keep verdict for five candidates — is over the
 * reject ratio and routes back to `extract`, but has no rejection verdicts at
 * all, so a verdict-driven critique came out empty and the retry prompt named
 * nothing. The model had no reason to answer differently, and the pass cost a
 * full extract+critic round to land in the same place.
 */
function rejectionCritique(
  candidates: ExtractionState["candidates"],
  verdicts: readonly CriticVerdict[],
): string {
  const verdictByTempId = new Map(verdicts.map((verdict) => [verdict.tempId, verdict]));
  const isKept = (candidate: ExtractionState["candidates"][number]) =>
    verdictByTempId.get(candidate.tempId)?.keep === true;
  const rejected = candidates
    .filter((candidate) => !isKept(candidate))
    .map((candidate) => ({
      claim: candidate.claim,
      reason: verdictByTempId.get(candidate.tempId)?.reason ?? "no verdict returned",
    }));
  const kept = candidates.filter(isKept).map((candidate) => candidate.claim);
  return formatCritique(rejected, kept);
}
