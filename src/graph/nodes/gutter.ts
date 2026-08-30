// Node 1, `gutter` — deterministic. Loads and reduces the transcript
// (02-ingestion.md). No LLM call, which is what keeps the single largest
// possible cost sink out of the graph entirely.
//
// Writes `gutterStats` and nothing else derived from the transcript. The
// guttered text itself is discarded when this function returns: everything a
// node writes is serialised into the checkpoint database on every transition,
// and redacted-but-still-transcript-derived content must not live there for
// up to THREAD_EXPIRY_DAYS. `extract` re-derives it — deterministically, and
// for free, since guttering involves no model call.

import type { ExtractionUpdate } from "../state.ts";
import type { GraphPorts } from "../ports.ts";
import type { GutteredSession } from "../../core/gutter/types.ts";

export interface GutterNodeState {
  transcriptPath: string;
}

/** Human turns in a guttered session — one of the three gutterStats figures. */
export function countHumanTurns(session: GutteredSession): number {
  return session.turns.filter((turn) => turn.role === "human").length;
}

export function makeGutterNode(ports: GraphPorts) {
  return async function gutterNode(state: GutterNodeState): Promise<ExtractionUpdate> {
    const session = await ports.gutter.gutter(state.transcriptPath);

    return {
      gutterStats: {
        tokenEstimate: session.tokenEstimate,
        humanTurns: countHumanTurns(session),
        redactionCount: session.redactionCount,
      },
    };
  };
}
