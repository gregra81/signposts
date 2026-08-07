// Zod schemas for the transcript-input wire types in 12-wire-contracts.md:
// Envelope and everything built on it (UserLine, AssistantLine, SystemLine,
// OtherLine, ContentBlock). Types are derived via `z.infer`, never
// hand-declared alongside their schema.
//
// This is the only regime covered so far because it's the only one with a
// consumer: step 4 of 16-build-plan.md (transcript reader and line
// classification). The rest of 12-wire-contracts.md — GutteredTurn,
// GutteredSession, Signpost, the graph types, Operation, GraphState, ... —
// has no consumer yet and is deliberately absent (YAGNI). It comes back as
// schemas when steps 8, 13 and 14 land; 12-wire-contracts.md remains the
// record of its shape until then.
//
// This regime is modelled as "undocumented internal format": required
// fields are the ones marked required (no `?`) in the doc's ts block, all
// unknown block/line types are skipped. Modelled with `z.looseObject`
// (extra keys kept) so a real Claude Code log with keys this doc doesn't
// mention still parses.
//
// `.signposts/config.yaml` has its own schema at ../config/schema.ts and
// is not repeated here.

import { z } from "zod";
import { DROP_BLOCK_TYPES } from "../config/constants.js";

// ---------------------------------------------------------------------------
// Input: transcript lines
// ---------------------------------------------------------------------------

// Block types the gutter always drops — reuses the type tags from
// DROP_BLOCK_TYPES rather than repeating "thinking" / "tool_result" as
// fresh literals. (Inline literals below — "text", "tool_use" — are plain
// strings, not module constants, so `no-magic-literal` doesn't fire on them.)
const [DROPPED_THINKING_TYPE, DROPPED_TOOL_RESULT_TYPE] = DROP_BLOCK_TYPES;

// Plain union, not discriminatedUnion: the doc says "all unknown [block]
// types skipped" (12-wire-contracts.md:9), so an unrecognised block type
// must still parse the line, not fail it. The catch-all is last and only
// requires `type` to be a string.
export const contentBlockSchema = z.union([
  z.looseObject({ type: z.literal("text"), text: z.string().optional() }),
  // Thinking content is always dropped downstream; kept optional here.
  z.looseObject({ type: z.literal(DROPPED_THINKING_TYPE), thinking: z.string().optional() }),
  // tool_use: only `name` survives gutter, but `id`/`input` are part of the wire shape.
  z.looseObject({
    type: z.literal("tool_use"),
    id: z.string().optional(),
    name: z.string().optional(),
    input: z.unknown().optional(),
  }),
  // tool_result content is always dropped downstream; kept optional here.
  z.looseObject({
    type: z.literal(DROPPED_TOOL_RESULT_TYPE),
    tool_use_id: z.string().optional(),
    content: z.unknown().optional(),
  }),
  // Catch-all: any block type this doc doesn't enumerate is skipped
  // downstream, but the line still has to parse. Excludes the four known
  // tags — via a fatal superRefine, not a plain refine — so a malformed
  // known-type block (e.g. text with a non-string `text`) aborts this
  // branch instead of silently matching here. Fatal is required: a
  // non-fatal refine failure is what zod's union picks as the reported
  // issue, which buries the real per-field error from the matching branch.
  z.looseObject({
    type: z.string().superRefine((t, ctx) => {
      if (t === "text" || t === DROPPED_THINKING_TYPE || t === "tool_use" || t === DROPPED_TOOL_RESULT_TYPE) {
        ctx.addIssue({ code: "custom", message: "known block type", fatal: true });
      }
    }),
  }),
]);
export type ContentBlock = z.infer<typeof contentBlockSchema>;

export const envelopeSchema = z.looseObject({
  uuid: z.string(),
  parentUuid: z.string().nullable(),
  sessionId: z.string(),
  timestamp: z.string(), // ISO 8601
  cwd: z.string().optional(), // maps session -> repo
  gitBranch: z.string().optional(),
  version: z.string().optional(), // Claude Code version; log unseen majors
  isSidechain: z.boolean().optional(), // true = subagent; skipped in v1
});
export type Envelope = z.infer<typeof envelopeSchema>;

export const userLineSchema = z.looseObject({
  ...envelopeSchema.shape,
  type: z.literal("user"),
  message: z
    .looseObject({
      role: z.literal("user"),
      content: z.union([z.string(), z.array(contentBlockSchema)]),
    })
    .optional(),
  isMeta: z.boolean().optional(),
  toolUseResult: z.unknown().optional(), // presence => not a human turn
  origin: z.looseObject({ kind: z.string() }).optional(), // kind==="human" is load-bearing
  promptSource: z.string().optional(), // "typed" | "suggestion_accepted" | string
});
export type UserLine = z.infer<typeof userLineSchema>;

export const assistantLineSchema = z.looseObject({
  ...envelopeSchema.shape,
  type: z.literal("assistant"),
  message: z
    .looseObject({
      role: z.literal("assistant"),
      content: z.array(contentBlockSchema),
    })
    .optional(),
  requestId: z.string().optional(),
});
export type AssistantLine = z.infer<typeof assistantLineSchema>;

// No body given in the doc beyond the union tag: an Envelope tagged "system".
export const systemLineSchema = z.looseObject({
  ...envelopeSchema.shape,
  type: z.literal("system"),
});
export type SystemLine = z.infer<typeof systemLineSchema>;

// Catch-all for any type tag ingestion doesn't recognise; unknown types are
// skipped downstream, but the line still has to parse. Excludes the three
// known tags — via a fatal superRefine, not a plain refine — so a malformed
// known-type line (e.g. a "user" line with a bad message) aborts this branch
// instead of silently falling through here. Fatal is required: a non-fatal
// refine failure is what zod's union picks as the reported issue, which
// buries the real per-field error from the matching branch.
export const otherLineSchema = z.looseObject({
  ...envelopeSchema.shape,
  type: z.string().superRefine((t, ctx) => {
    if (t === "user" || t === "assistant" || t === "system") {
      ctx.addIssue({ code: "custom", message: "known line type", fatal: true });
    }
  }),
});
export type OtherLine = z.infer<typeof otherLineSchema>;

// Not a discriminated union: OtherLine's `type` is an arbitrary string, which
// zod's discriminatedUnion cannot route on. The catch-all excludes the three
// known tags itself, so member order doesn't affect the result.
export const transcriptLineSchema = z.union([
  userLineSchema,
  assistantLineSchema,
  systemLineSchema,
  otherLineSchema,
]);
export type TranscriptLine = z.infer<typeof transcriptLineSchema>;
