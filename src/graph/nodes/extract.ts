// Node 2, `extract` — LLM, structured output.
//
// Re-gutters the transcript rather than reading text out of state (see
// ../nodes/gutter.ts for why), renders it into 14-prompts.md's user turn, and
// asks for `Candidate[]` against a JSON schema.
//
// Both loops send work back here, and both say why. The reflection loop's
// critique and the self-correction loop's validation errors are appended to
// the user turn and then cleared, so the next pass starts from a clean slate
// and neither loop can mistake a stale reason for a fresh one. A retry that
// did not carry its reason was the earlier bug: the regenerated prompt came
// back byte-identical to the one that failed.
//
// `extractAttempts` counts the runs. It is not either loop's bound — each
// loop counts its own retries (src/core/graph/routing.ts).
//
// The keyed channels are reset (`null`) because a retry produces candidates
// under fresh tempIds: without the reset, neighbours and classifications
// belonging to the discarded batch would linger and be read back as if they
// described the new one.

import { acceptCandidates } from "../../core/graph/candidates.ts";
import { extractUserTurn } from "../../core/prompts/user-turns.ts";
import { renderGutteredSession } from "../../core/gutter/render.ts";
import { callStructured } from "../llm.ts";
import type { ExtractionState, ExtractionUpdate } from "../state.ts";
import type { GraphPorts } from "../ports.ts";

export function makeExtractNode(ports: GraphPorts) {
  return async function extractNode(state: ExtractionState): Promise<ExtractionUpdate> {
    const session = await ports.gutter.gutter(state.transcriptPath);

    const { candidates } = await callStructured({
      model: ports.model,
      node: "extract",
      user: extractUserTurn({
        repo: state.repo,
        guttered: renderGutteredSession(session),
        critique: state.critique,
        validationErrors: state.validationErrors,
      }),
    });

    return {
      candidates: acceptCandidates(candidates),
      extractAttempts: state.extractAttempts + 1,
      // Both retry reasons are consumed here, so a later pass cannot re-send a
      // critique or a validation error the model has already answered.
      critique: undefined,
      validationErrors: [],
      neighbours: null,
      classifications: null,
      resolutions: null,
    };
  };
}
