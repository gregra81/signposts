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
    const { verdicts } = await callStructured({
      model: ports.model,
      node: "critic",
      user: criticUserTurn(state.repo, state.candidates),
    });

    const route = criticRoute({
      candidates: state.candidates,
      verdicts,
      criticRetries: state.criticRetries,
    });

    if (route === "retry-extract") {
      // Candidates are left untouched: they are about to be replaced wholesale
      // by the retry, and narrowing them here would only shrink what a second
      // rejection has to work with.
      return {
        critique: rejectionCritique(state.candidates, verdicts),
        criticRetries: state.criticRetries + 1,
      };
    }

    return { candidates: survivors(state.candidates, verdicts), critique: undefined };
  };
}

function rejectionCritique(
  candidates: ExtractionState["candidates"],
  verdicts: readonly CriticVerdict[],
): string {
  const claimByTempId = new Map(candidates.map((candidate) => [candidate.tempId, candidate.claim]));
  const rejected = verdicts
    .filter((verdict) => !verdict.keep)
    .map((verdict) => ({
      claim: claimByTempId.get(verdict.tempId) ?? verdict.tempId,
      reason: verdict.reason,
    }));
  return formatCritique(rejected);
}
