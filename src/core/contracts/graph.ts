// Zod schemas for 12-wire-contracts.md's "Graph types", "Operations" and
// "Graph state" regimes — the shapes the extraction graph
// (04-extraction-graph.md) passes between its nodes and writes into a
// checkpoint.
//
// Split out of ./schema.ts rather than appended to it: that file models the
// transcript-input regime (an undocumented external wire format, therefore
// z.looseObject and permissive). This one models formats we own end to end —
// LLM structured output validated on arrival, and our own checkpoint payload
// — so it is strict z.object throughout. An extra key here is a bug, not a
// forward-compatibility signal.
//
// Category/Scope/Signpost are NOT redefined here. They already have one home
// in ../signpost/schema.ts, which is where claim validation lives; these
// schemas import them.
//
// Every LLM node validates its response against the matching schema in this
// file, and derives the JSON Schema it sends as `output_config.format` from
// the same source (see ./structured-output.ts). One definition, both
// directions — there is no free-text parsing anywhere in the graph.

import { z } from "zod";
import { ALWAYS_HUMAN_OPS, STATE_VERSION } from "../config/constants.ts";
import { categorySchema, scopeSchema, signpostSchema, claimSchema } from "../signpost/schema.ts";

// ---------------------------------------------------------------------------
// Graph types
// ---------------------------------------------------------------------------

// `claim` is a plain string here, not claimSchema. 12-wire-contracts.md types
// it that way, and the difference is load-bearing: claim validation is node
// 7's job (04-extraction-graph.md, "claim is a single sentence within length
// limits"), and node 7 exists to feed failures back through the
// self-correction loop. Validating it on arrival at `extract` instead would
// turn a candidate the loop is designed to repair into a hard failure of the
// whole run.
export const candidateSchema = z.object({
  tempId: z.string(),
  claim: z.string(),
  category: categorySchema,
  scope: scopeSchema,
  evidence: z.string(),
  confidence: z.number().min(0).max(1),
  // The human used speculative language ("I think", "probably", "IIRC").
  // When true, confidence is capped at HEDGE_CONFIDENCE_CAP — applied by
  // ../graph/hedge.ts, not by this schema: the model reports what it saw,
  // the cap is our policy on top of it.
  hedged: z.boolean(),
});
export type Candidate = z.infer<typeof candidateSchema>;

/**
 * A retrieved neighbour: a recorded signpost, plus what it is still waiting on
 * if an earlier session in this same run proposed it (06-review-and-pr.md,
 * "Reindex within a run, not only at commit").
 *
 * Two pending states rather than one boolean, because the gate has to tell
 * them apart:
 *
 *   - `in_pr` — the proposal cleared the confidence gate and session N's
 *     `commit` has already written it into the branch. An operation against it
 *     may auto-publish, because the two land in the same pull request.
 *   - `awaiting_review` — a person is holding it and may reject it. An
 *     operation against it inherits that review (`pending_neighbour` below);
 *     auto-publishing one would put a reference to a signpost in the branch
 *     that may never exist.
 *
 * `classify` is shown the field too, and CLASSIFY_SYSTEM (../prompts/system.ts,
 * transcribed from 14-prompts.md) tells the model what the two values mean.
 *
 * It lives here rather than on ../signpost/schema.ts's signpostSchema because
 * that schema is the on-disk file, and nothing pending is ever written to disk.
 * It is absent, not `null`, for a merged neighbour, so the classify user turn
 * for an ordinary corpus is byte-for-byte what it was before this existed —
 * see ../prompts/user-turns.ts.
 */
export const pendingStateSchema = z.enum(["in_pr", "awaiting_review"]);
export type PendingState = z.infer<typeof pendingStateSchema>;

/** Single source of truth for the two pending literals. */
export const PENDING_STATES = pendingStateSchema.enum;

export const neighbourSignpostSchema = signpostSchema.extend({
  pending: pendingStateSchema.optional(),
});
export type NeighbourSignpost = z.infer<typeof neighbourSignpostSchema>;

export const criticVerdictSchema = z.object({
  tempId: z.string(),
  keep: z.boolean(),
  reason: z.string(),
  /** May only lower — enforced in ../graph/survivors.ts, which applies it. */
  adjustedConfidence: z.number().min(0).max(1).optional(),
});
export type CriticVerdict = z.infer<typeof criticVerdictSchema>;

export const classificationKindSchema = z.enum([
  "NOVEL",
  "DUPLICATE",
  "REFINEMENT",
  "CONTRADICTION",
]);
export type ClassificationKind = z.infer<typeof classificationKindSchema>;

/** Single source of truth for the four kind literals, for callers switching on them. */
export const CLASSIFICATION_KINDS = classificationKindSchema.enum;

// `relatedId` is "required unless NOVEL" (12-wire-contracts.md). Expressed as
// a superRefine rather than a discriminated union so the failure reads as one
// missing field on a well-formed object, which is what a retry prompt needs
// to say back to the model.
export const classificationSchema = z
  .object({
    tempId: z.string(),
    kind: classificationKindSchema,
    relatedId: z.string().optional(),
    rationale: z.string(),
  })
  .superRefine((value, ctx) => {
    if (value.kind !== CLASSIFICATION_KINDS.NOVEL && value.relatedId === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["relatedId"],
        message: `relatedId is required when kind is ${value.kind}`,
      });
    }
  });
export type Classification = z.infer<typeof classificationSchema>;

export const resolutionOutcomeSchema = z.enum([
  "new_wins",
  "existing_wins",
  "both_scoped",
  "undecidable",
]);
export type ResolutionOutcome = z.infer<typeof resolutionOutcomeSchema>;

/** Single source of truth for the four outcome literals. */
export const RESOLUTION_OUTCOMES = resolutionOutcomeSchema.enum;

// `newScope`/`existingScope` are "required when both_scoped" — same
// superRefine treatment, and for the same reason, as classification's
// relatedId above.
export const resolutionSchema = z
  .object({
    tempId: z.string(),
    outcome: resolutionOutcomeSchema,
    reasoning: z.string(),
    /** Phase 4.5: files/commits actually inspected. */
    evidenceChecked: z.array(z.string()).optional(),
    newScope: scopeSchema.optional(),
    existingScope: scopeSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.outcome !== RESOLUTION_OUTCOMES.both_scoped) {
      return;
    }
    for (const field of ["newScope", "existingScope"] as const) {
      if (value[field] === undefined) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `${field} is required when outcome is ${RESOLUTION_OUTCOMES.both_scoped}`,
        });
      }
    }
  });
export type Resolution = z.infer<typeof resolutionSchema>;

// ---------------------------------------------------------------------------
// Operations — the graph's output. `commit` consumes only this.
// ---------------------------------------------------------------------------

/**
 * The five operation tags, in one place.
 *
 * The three that always route to a human are read out of ALWAYS_HUMAN_OPS
 * rather than repeated: 13-constants.md owns those literals, and a tag spelled
 * differently in the schema than in the gate policy would produce an operation
 * the gate silently treats as auto-publishable.
 */
const [REFINE_TAG, SUPERSEDE_TAG, RETIRE_TAG] = ALWAYS_HUMAN_OPS;

export const OPERATION_TAGS = {
  add: "add",
  reinforce: "reinforce",
  refine: REFINE_TAG,
  supersede: SUPERSEDE_TAG,
  retire: RETIRE_TAG,
} as const;

export const operationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal(OPERATION_TAGS.add), signpost: signpostSchema }),
  // `author` is a REAL git email here, never a pseudonym (12-wire-contracts.md).
  z.object({
    op: z.literal(OPERATION_TAGS.reinforce),
    id: z.string(),
    sessionId: z.string(),
    author: z.string(),
  }),
  z.object({
    op: z.literal(OPERATION_TAGS.refine),
    id: z.string(),
    claim: claimSchema.optional(),
    evidence: z.string().optional(),
    scope: scopeSchema.optional(),
  }),
  z.object({ op: z.literal(OPERATION_TAGS.supersede), id: z.string(), replacement: signpostSchema }),
  z.object({ op: z.literal(OPERATION_TAGS.retire), id: z.string(), reason: z.string() }),
]);
export type Operation = z.infer<typeof operationSchema>;

export const gateReasonSchema = z.enum([
  "low_confidence",
  "edits_existing",
  "deletes_existing",
  "unresolved_contradiction",
  "bootstrap_run",
  // The operation targets a signpost an earlier session in this same run
  // proposed and a person has not accepted yet — `awaiting_review` above
  // (06-review-and-pr.md, "Reindex within a run"). Sixth reason, added with
  // the within-run reindex: before it, a pending id was absent from
  // `existingIds` and `validate` dropped the candidate, so an operation could
  // never target one. Now that it can, the operation inherits the neighbour's
  // review — otherwise a `reinforce` of a proposal a person may reject
  // auto-publishes a reference to a signpost that never exists.
  "pending_neighbour",
]);
export type GateReason = z.infer<typeof gateReasonSchema>;

/** Single source of truth for the six gate-reason literals. */
export const GATE_REASONS = gateReasonSchema.enum;

/**
 * The operations one candidate produced, kept together with the confidence
 * that produced them.
 *
 * Grouping matters twice. `validate` drops a candidate whole, so a candidate
 * can never be half-applied; and the gate needs to know which operations came
 * from a contradiction nobody settled, which is a fact about the candidate,
 * not about any single operation it produced.
 */
export const candidateOperationsSchema = z.object({
  tempId: z.string(),
  confidence: z.number().min(0).max(1),
  operations: z.array(operationSchema),
});
export type CandidateOperations = z.infer<typeof candidateOperationsSchema>;

export const gatedOperationsSchema = z.object({
  auto: z.array(operationSchema),
  needsHuman: z.array(z.object({ operation: operationSchema, reason: gateReasonSchema })),
});
export type GatedOperations = z.infer<typeof gatedOperationsSchema>;

export const humanDecisionSchema = z
  .object({
    decision: z.enum(["accept", "reject", "edit"]),
    edited: operationSchema.optional(),
    decidedAt: z.string(),
  })
  .superRefine((value, ctx) => {
    if (value.decision === "edit" && value.edited === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["edited"],
        message: 'edited is required when decision is "edit"',
      });
    }
  });
export type HumanDecision = z.infer<typeof humanDecisionSchema>;

// ---------------------------------------------------------------------------
// Graph state
// ---------------------------------------------------------------------------

export const gutterStatsSchema = z.object({
  tokenEstimate: z.number(),
  humanTurns: z.number(),
  redactionCount: z.number(),
});
export type GutterStats = z.infer<typeof gutterStatsSchema>;

/**
 * The whole checkpoint payload. Guttered text is deliberately absent —
 * everything here is serialised to the checkpoint database on every node
 * transition, and 12-wire-contracts.md forbids persisting transcript content
 * that far. State carries `transcriptPath` + `contentHash`; `extract`
 * re-gutters, which is deterministic and therefore free.
 *
 * Records, never `Map`s: a Map does not survive JSON serialisation into a
 * checkpoint — it resumes as `{}`, silently and without error.
 *
 * `version` is pinned to STATE_VERSION, so a checkpoint written by an older
 * shape fails this parse rather than resuming into code that no longer
 * understands it. See ../graph/state-version.ts for what happens next.
 */
export const graphStateSchema = z.object({
  version: z.literal(STATE_VERSION),
  sessionId: z.string(),
  repo: z.string(),
  repoRoot: z.string(),
  contentHash: z.string(),
  transcriptPath: z.string(),
  gutterStats: gutterStatsSchema,
  candidates: z.array(candidateSchema),
  critique: z.string().optional(),
  extractAttempts: z.number(),
  // Retries the reflection loop has issued, which is not the same as the
  // number of `extract` runs: the self-correction loop also re-runs `extract`,
  // and a shared counter let its retry silently spend the critic's budget.
  criticRetries: z.number(),
  neighbours: z.record(z.string(), z.array(neighbourSignpostSchema)),
  classifications: z.record(z.string(), classificationSchema),
  resolutions: z.record(z.string(), resolutionSchema),
  // What `validate` passed, still grouped by candidate. Written by node 7 and
  // read by node 8, which needs the per-candidate confidence and the
  // unresolved-contradiction marking that a flat Operation[] cannot carry.
  validated: z.array(candidateOperationsSchema),
  // The graph's output: what `commit` actually applied, after the gate and any
  // human decisions. 12-wire-contracts.md's "commit consumes only this".
  operations: z.array(operationSchema),
  // The `confidence_gate` partition. 12-wire-contracts.md's GraphState sketch
  // predates a working gate node and omits it, but node 9 cannot resume
  // without it: LangGraph re-executes an interrupted node from the top, so
  // `human_review` needs the partition it interrupted on, and the confidence
  // that produced it is gone by then. Recorded at version 1 as part of
  // defining that shape, not as a change to it.
  gated: gatedOperationsSchema,
  validationErrors: z.array(z.string()),
  validateAttempts: z.number(),
  humanDecisions: z.record(z.string(), humanDecisionSchema),
});
export type GraphState = z.infer<typeof graphStateSchema>;
