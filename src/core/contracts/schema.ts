// Zod schema for every wire type in 12-wire-contracts.md. Types are derived
// via `z.infer`, never hand-declared alongside their schema.
//
// Two regimes, per the doc's own framing:
//  - Transcript input (Envelope and everything built on it: UserLine,
//    AssistantLine, SystemLine, OtherLine, ContentBlock) is "undocumented
//    internal format": required fields are the ones marked required (no
//    `?`) in the doc's ts block, all unknown block/line types are skipped.
//    Modelled with `z.looseObject` (extra keys kept) so a real Claude Code
//    log with keys this doc doesn't mention still parses.
//  - Everything downstream of ingestion (Signpost, the graph types,
//    Operation, GraphState, ...) is ours: fields are required as the doc
//    states them, no passthrough.
//
// `.signposts/config.yaml` has its own schema at ../config/schema.ts and
// is not repeated here.

import { z } from "zod";
import {
  ALWAYS_HUMAN_OPS,
  CLAIM_ALLOW_NEWLINE,
  CLAIM_MAX_CHARS,
  DROP_BLOCK_TYPES,
  ID_PATTERN,
  STATE_VERSION,
} from "../config/constants.js";

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

// ---------------------------------------------------------------------------
// Ingestion output
// ---------------------------------------------------------------------------

export const gutteredTurnSchema = z.object({
  role: z.enum(["human", "assistant"]),
  text: z.string(), // redacted; assistant = trimmed head
  toolNames: z.array(z.string()).optional(), // assistant only, names without args
  filesTouched: z.array(z.string()).optional(),
  at: z.string(),
});
export type GutteredTurn = z.infer<typeof gutteredTurnSchema>;

export const gutteredSessionSchema = z.object({
  sessionId: z.string(),
  contentHash: z.string(), // sha256 of raw file; dedup key with sessionId
  repo: z.string(), // "owner/name" from git remote
  repoRoot: z.string(), // absolute path
  branch: z.string().optional(),
  startedAt: z.string(),
  lastActivityAt: z.string(),
  turns: z.array(gutteredTurnSchema),
  tokenEstimate: z.number(),
  redactionCount: z.number(),
});
export type GutteredSession = z.infer<typeof gutteredSessionSchema>;

// ---------------------------------------------------------------------------
// The signpost
// ---------------------------------------------------------------------------

export const categorySchema = z.enum(["correction", "preference", "gotcha", "decision", "environment"]);
export type Category = z.infer<typeof categorySchema>;

export const scopeSchema = z.object({
  repo: z.string(),
  paths: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(),
});
export type Scope = z.infer<typeof scopeSchema>;

export const provenanceSchema = z.object({
  session_ids: z.array(z.string()),
  authors: z.array(z.string()), // REAL git config user.email
  first_seen: z.string(), // ISO date
  last_reinforced: z.string(),
});
export type Provenance = z.infer<typeof provenanceSchema>;

// ONE sentence, <= CLAIM_MAX_CHARS, no newline (CLAIM_ALLOW_NEWLINE). Shared
// by Signpost and Candidate.
const claimSchema = z
  .string()
  .max(CLAIM_MAX_CHARS)
  .refine((v) => CLAIM_ALLOW_NEWLINE || !v.includes("\n"), "claim must not contain a newline");

// 1-3 sentences, paraphrased. Shared by Signpost and Candidate. No length
// limit is stated in the doc beyond the sentence-count guidance.
const evidenceSchema = z.string();

export const signpostSchema = z.object({
  id: z.string().regex(ID_PATTERN), // kebab-case slug, unique per repo
  claim: claimSchema,
  category: categorySchema,
  scope: scopeSchema,
  evidence: evidenceSchema,
  confidence: z.number().min(0).max(1),
  provenance: provenanceSchema,
  status: z.enum(["active", "superseded"]),
  supersedes: z.array(z.string()).optional(),
});
export type Signpost = z.infer<typeof signpostSchema>;

// ---------------------------------------------------------------------------
// Graph types
// ---------------------------------------------------------------------------

export const candidateSchema = z.object({
  tempId: z.string(), // stable within one run
  claim: claimSchema,
  category: categorySchema,
  scope: scopeSchema,
  evidence: evidenceSchema,
  confidence: z.number().min(0).max(1),
  hedged: z.boolean(),
});
export type Candidate = z.infer<typeof candidateSchema>;

export const criticVerdictSchema = z.object({
  tempId: z.string(),
  keep: z.boolean(),
  reason: z.string(),
  adjustedConfidence: z.number().min(0).max(1).optional(), // may only lower
});
export type CriticVerdict = z.infer<typeof criticVerdictSchema>;

export const classificationKindSchema = z.enum(["NOVEL", "DUPLICATE", "REFINEMENT", "CONTRADICTION"]);
export type ClassificationKind = z.infer<typeof classificationKindSchema>;

export const classificationSchema = z
  .object({
    tempId: z.string(),
    kind: classificationKindSchema,
    relatedId: z.string().optional(), // required unless NOVEL
    rationale: z.string(),
  })
  .superRefine((val, ctx) => {
    if (val.kind !== "NOVEL" && val.relatedId === undefined) {
      ctx.addIssue({ code: "custom", path: ["relatedId"], message: "relatedId is required unless kind is NOVEL" });
    }
  });
export type Classification = z.infer<typeof classificationSchema>;

export const resolutionSchema = z
  .object({
    tempId: z.string(),
    outcome: z.enum(["new_wins", "existing_wins", "both_scoped", "undecidable"]),
    reasoning: z.string(),
    evidenceChecked: z.array(z.string()).optional(), // Phase 4.5: files/commits actually inspected
    newScope: scopeSchema.optional(), // required when both_scoped
    existingScope: scopeSchema.optional(), // required when both_scoped
  })
  .superRefine((val, ctx) => {
    if (val.outcome === "both_scoped") {
      if (val.newScope === undefined) {
        ctx.addIssue({ code: "custom", path: ["newScope"], message: "newScope is required when outcome is both_scoped" });
      }
      if (val.existingScope === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["existingScope"],
          message: "existingScope is required when outcome is both_scoped",
        });
      }
    }
  });
export type Resolution = z.infer<typeof resolutionSchema>;

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

// refine/supersede/retire are exactly ALWAYS_HUMAN_OPS — every one of them alters
// approved knowledge and is never auto-published, whatever its confidence.
// (Destructured from the constant, not re-literalled, only because
// `no-magic-literal` fires on these specific strings — "add"/"reinforce"
// below are plain strings, don't "fix" this either direction.)
const [REFINE_OP, SUPERSEDE_OP, RETIRE_OP] = ALWAYS_HUMAN_OPS;

export const operationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), signpost: signpostSchema }),
  z.object({ op: z.literal("reinforce"), id: z.string(), sessionId: z.string(), author: z.string() }), // REAL email, never a pseudonym
  z.object({
    op: z.literal(REFINE_OP),
    id: z.string(),
    claim: claimSchema.optional(),
    evidence: evidenceSchema.optional(),
    scope: scopeSchema.optional(),
  }),
  z.object({ op: z.literal(SUPERSEDE_OP), id: z.string(), replacement: signpostSchema }),
  z.object({ op: z.literal(RETIRE_OP), id: z.string(), reason: z.string() }),
]);
export type Operation = z.infer<typeof operationSchema>;

export const gateReasonSchema = z.enum([
  "low_confidence",
  "edits_existing",
  "deletes_existing",
  "unresolved_contradiction",
  "bootstrap_run", // first run in a repo — everything goes to a human
]);
export type GateReason = z.infer<typeof gateReasonSchema>;

export const gatedOperationsSchema = z.object({
  auto: z.array(operationSchema),
  needsHuman: z.array(z.object({ operation: operationSchema, reason: gateReasonSchema })),
});
export type GatedOperations = z.infer<typeof gatedOperationsSchema>;

export const humanDecisionSchema = z
  .object({
    decision: z.enum(["accept", "reject", "edit"]),
    edited: operationSchema.optional(), // required when decision==="edit"
    decidedAt: z.string(),
  })
  .superRefine((val, ctx) => {
    if (val.decision === "edit" && val.edited === undefined) {
      ctx.addIssue({ code: "custom", path: ["edited"], message: "edited is required when decision is edit" });
    }
  });
export type HumanDecision = z.infer<typeof humanDecisionSchema>;

// ---------------------------------------------------------------------------
// Graph state
// ---------------------------------------------------------------------------

export const graphStateSchema = z.object({
  version: z.literal(STATE_VERSION), // bump on shape change; unrecognised => discard thread
  sessionId: z.string(),
  repo: z.string(),
  repoRoot: z.string(),
  contentHash: z.string(),
  transcriptPath: z.string(), // guttered text is NOT here
  gutterStats: z.object({
    tokenEstimate: z.number(),
    humanTurns: z.number(),
    redactionCount: z.number(),
  }),
  candidates: z.array(candidateSchema),
  critique: z.string().optional(),
  extractAttempts: z.number(),
  // Records, not Maps — Map does not survive JSON serialisation into the checkpoint.
  neighbours: z.record(z.string(), z.array(signpostSchema)), // tempId -> retrieved
  classifications: z.record(z.string(), classificationSchema),
  resolutions: z.record(z.string(), resolutionSchema),
  operations: z.array(operationSchema),
  validationErrors: z.array(z.string()),
  validateAttempts: z.number(),
  humanDecisions: z.record(z.string(), humanDecisionSchema),
});
export type GraphState = z.infer<typeof graphStateSchema>;

// ---------------------------------------------------------------------------
// Provider adapter payloads
// ---------------------------------------------------------------------------
// ModelProvider itself is a behavioural interface (generic method), not wire
// data, and is out of scope. Its payload types are in scope.

export const nodeNameSchema = z.enum(["extract", "critic", "classify", "resolve"]);
export type NodeName = z.infer<typeof nodeNameSchema>;

export const usageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
  model: z.string(),
  costUsd: z.number(),
});
export type Usage = z.infer<typeof usageSchema>;

// ---------------------------------------------------------------------------
// Tools (Phase 4.5)
// ---------------------------------------------------------------------------

export const toolDefSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.unknown(), // JSONSchema: external, unspecified type -> modelled loosely
});
export type ToolDef = z.infer<typeof toolDefSchema>;
