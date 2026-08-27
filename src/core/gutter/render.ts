// Renders a GutteredSession into the `{guttered}` block of `extract`'s user
// turn (14-prompts.md). PURE.
//
// One line per turn, tagged with the speaker, so the model can see which
// words are the human's — the whole extraction rests on that distinction
// ("knowledge that exists ONLY because a human said it"). Tool names and
// touched files ride along on assistant turns as context for what the human
// was reacting to.

import type { GutteredSession, GutteredTurn } from "./types.ts";

const HUMAN_LABEL = "human";
const ASSISTANT_LABEL = "assistant";

function renderTurn(turn: GutteredTurn): string {
  const label = turn.role === "human" ? HUMAN_LABEL : ASSISTANT_LABEL;
  const annotations: string[] = [];
  if (turn.toolNames !== undefined && turn.toolNames.length > 0) {
    annotations.push(`tools: ${turn.toolNames.join(", ")}`);
  }
  if (turn.filesTouched !== undefined && turn.filesTouched.length > 0) {
    annotations.push(`files: ${turn.filesTouched.join(", ")}`);
  }
  const suffix = annotations.length === 0 ? "" : ` [${annotations.join(" | ")}]`;
  return `${label}: ${turn.text}${suffix}`;
}

export function renderGutteredSession(session: GutteredSession): string {
  return session.turns.map(renderTurn).join("\n");
}
