// Zod schemas for the transcript-input wire types in 12-wire-contracts.md:
// Envelope and everything built on it (UserLine, AssistantLine, SystemLine,
// OtherLine). Types are derived via `z.infer`, never hand-declared alongside
// their schema.
//
// This is the only regime covered so far because it's the only one with a
// consumer: step 4 of 16-build-plan.md (transcript reader and line
// classification). It covers envelopes and line classification only — block
// structure inside message.content is deliberately left as `z.unknown()`,
// since the gutter (step 5) is the only consumer of block structure and
// isn't built yet; it will parse blocks itself where it reads them. The
// rest of 12-wire-contracts.md — GutteredTurn, GutteredSession, Signpost,
// the graph types, Operation, GraphState, ... — has no consumer yet and is
// deliberately absent (YAGNI). It comes back as schemas when steps 5, 8, 13
// and 14 land; 12-wire-contracts.md remains the record of its shape until
// then.
//
// Step 13 landed: `Operation` did NOT come back as a zod schema here.
// src/core/gate/gate.ts only switches on the `op` tag, never reads a
// payload field, so it declares its own minimal tag-only `Operation` type
// instead. Don't add a second, fuller `Operation` here unless a real
// consumer needs the payload shape — one type, in gate.ts, until then.
//
// This regime is modelled as "undocumented internal format": required
// fields are the ones marked required (no `?`) in the doc's ts block, all
// unknown line types are skipped. Modelled with `z.looseObject` (extra keys
// kept) so a real Claude Code log with keys this doc doesn't mention still
// parses.
//
// `.signposts/config.yaml` has its own schema at ../config/schema.ts and
// is not repeated here.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Input: transcript lines
// ---------------------------------------------------------------------------

export const envelopeSchema = z.looseObject({
  // Required so a corrupt/truncated line fails validation into
  // linesSkipped (the drift tripwire) — not because either value is
  // consumed downstream.
  uuid: z.string(),
  parentUuid: z.string().nullable(),
  sessionId: z.string(),
  timestamp: z.string(), // ISO 8601
  cwd: z.string().optional(), // maps session -> repo
  gitBranch: z.string().optional(),
  version: z.string().optional(), // Claude Code version; nothing reads this today
  isSidechain: z.boolean().optional(), // true = subagent; skipped in v1
});
export type Envelope = z.infer<typeof envelopeSchema>;

// Single source of truth for the three type tags this regime handles.
// otherLineSchema's superRefine excludes exactly these; classify.ts's
// parseLine routes on exactly these. Two hand-maintained copies would let a
// tag be added to one and forgotten in the other — an invalid line of that
// type would then fall through to otherLineSchema, pass as "parsed", and get
// cast to a line type whose envelope fields are all actually undefined.
export const KNOWN_LINE_TYPES = new Set(["user", "assistant", "system"]);

export const userLineSchema = z.looseObject({
  ...envelopeSchema.shape,
  type: z.literal("user"),
  message: z
    .looseObject({
      role: z.literal("user"),
      content: z.unknown(),
    })
    .optional(),
  origin: z.looseObject({ kind: z.string() }).optional(), // kind==="human" is load-bearing
});
export type UserLine = z.infer<typeof userLineSchema>;

export const assistantLineSchema = z.looseObject({
  ...envelopeSchema.shape,
  type: z.literal("assistant"),
  message: z
    .looseObject({
      role: z.literal("assistant"),
      content: z.unknown(),
    })
    .optional(),
});
export type AssistantLine = z.infer<typeof assistantLineSchema>;

// No body given in the doc beyond the union tag: an Envelope tagged "system".
export const systemLineSchema = z.looseObject({
  ...envelopeSchema.shape,
  type: z.literal("system"),
});
export type SystemLine = z.infer<typeof systemLineSchema>;

// Catch-all for any type tag ingestion doesn't recognise. Deliberately does
// NOT require the envelope shape: real transcripts interleave sidecar
// records (type "mode", "ai-title", "bridge-session", "file-history-snapshot",
// ...) that carry no uuid/parentUuid/timestamp at all — they aren't envelopes,
// they're a different kind of line that happens to share the file. Requiring
// envelopeSchema here made every one of those fail validation and get counted
// as malformed alongside actually-corrupt lines (~32% of a real transcript,
// observed 0% actually corrupt). An unrecognised type is skipped because
// ingestion doesn't handle it, not because it failed to parse.
// Excludes the three known tags — via a fatal superRefine, not a plain
// refine — so a malformed known-type line (e.g. a "user" line with a bad
// message) aborts this branch instead of silently falling through here.
// Fatal is required: a non-fatal refine failure is what zod's union picks as
// the reported issue, which buries the real per-field error from the
// matching branch.
export const otherLineSchema = z.looseObject({
  type: z.string().superRefine((t, ctx) => {
    if (KNOWN_LINE_TYPES.has(t)) {
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
