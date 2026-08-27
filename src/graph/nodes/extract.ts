// Node 2, `extract` — LLM, structured output.
//
// Re-gutters the transcript rather than reading text out of state (see
// ../nodes/gutter.ts for why), renders it into 14-prompts.md's user turn, and
// asks for `Candidate[]` against a JSON schema.
//
// On a retry through the reflection loop the critique is appended to the user
// turn and `critique` is cleared, so the next pass through `critic` starts
// from a clean slate and the loop cannot mistake a stale critique for a fresh
// rejection. `extractAttempts` is incremented here, at the point the attempt
// is actually spent — that counter is the reflection loop's bound.
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
      }),
    });

    return {
      candidates: acceptCandidates(candidates),
      extractAttempts: state.extractAttempts + 1,
      critique: undefined,
      neighbours: null,
      classifications: null,
      resolutions: null,
    };
  };
}
