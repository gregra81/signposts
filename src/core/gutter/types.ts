// Input/output shapes for the gutter (02-ingestion.md "The gutter",
// 15-spec.md D3). Deliberately a plain TypeScript regime, not zod:
// gutter.ts consumes turns already shaped by an upstream assembly step
// (out of scope here, per this build task's R8 — no GutteredSession
// assembly), not raw `unknown` JSON off disk. Runtime narrowing of
// message.content (contracts/schema.ts leaves it z.unknown()) lives in
// gutter/input.ts — that's the "will parse blocks itself where it reads
// them" step schema.ts's comment refers to; gutter.ts's job starts one
// step after that, on already-typed input.
//
// ContentBlock mirrors 12-wire-contracts.md's block union exactly —
// contracts/schema.ts leaves message.content as z.unknown() and notes the
// gutter "will parse blocks itself where it reads them", so this is that
// definition, kept local since nothing else in the codebase needs it yet.

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking?: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown };

export interface HumanGutterInputTurn {
  role: "human";
  text: string;
  at: string;
}

export interface AssistantGutterInputTurn {
  role: "assistant";
  blocks: ContentBlock[];
  at: string;
}

/** One turn of the ordered sequence gutterTurns() reduces. */
export type GutterInputTurn = HumanGutterInputTurn | AssistantGutterInputTurn;

/** 12-wire-contracts.md's GutteredTurn — the turns array of GutteredSession. */
export interface GutteredTurn {
  role: "human" | "assistant";
  text: string;
  toolNames?: string[];
  filesTouched?: string[];
  at: string;
}
