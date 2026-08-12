// Zod schemas for the Signpost regime in 12-wire-contracts.md ("## The
// signpost") and 03-memory-model.md ("## Schema" / "## On-disk format").
// Types are derived via `z.infer`, matching the pattern in
// ../contracts/schema.ts.
//
// Unlike contracts/schema.ts (undocumented external wire format, modelled
// permissively with z.looseObject), this regime is a format we own: we are
// both the only writer and the only reader of `.signposts/**/*.md`. Extra
// keys in frontmatter are corruption, not a forward-compat signal — so
// these are plain z.object, which strips/rejects unknown shape rather than
// passing it through.
//
// Claim validation (03-memory-model.md "Why `claim` is one sentence") is
// enforced here, in the schema, so a bad claim fails parseSignpost itself
// rather than a separate check a caller could forget to run.

import { z } from "zod";
import { CLAIM_ALLOW_NEWLINE, CLAIM_MAX_CHARS, CLAIM_REJECT_SUBSTRINGS, EVIDENCE_MAX_CHARS, ID_PATTERN } from "../config/constants.js";

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
  authors: z.array(z.string()),
  first_seen: z.string(),
  last_reinforced: z.string(),
});
export type Provenance = z.infer<typeof provenanceSchema>;

// Each rule adds its own issue (rather than bailing on the first) so a
// caller inspecting `result.error.issues` can tell exactly which rule(s)
// a bad claim tripped.
export const claimSchema = z.string().superRefine((claim, ctx) => {
  if (!CLAIM_ALLOW_NEWLINE && claim.includes("\n")) {
    ctx.addIssue({ code: "custom", message: "claim must be a single sentence: no newline allowed" });
  }
  if (claim.length > CLAIM_MAX_CHARS) {
    ctx.addIssue({ code: "custom", message: `claim exceeds ${CLAIM_MAX_CHARS} characters` });
  }
  for (const substring of CLAIM_REJECT_SUBSTRINGS) {
    if (claim.includes(substring)) {
      ctx.addIssue({ code: "custom", message: `claim smuggles a second proposition via ${JSON.stringify(substring)}` });
    }
  }
});

export const statusSchema = z.enum(["active", "superseded"]);
export type Status = z.infer<typeof statusSchema>;

// Single source of truth for the "active" literal: the schema's own enum,
// not a second hand-maintained string.
export const ACTIVE_STATUS = statusSchema.enum.active;

export const signpostSchema = z.object({
  id: z.string().regex(ID_PATTERN, "id must be a kebab-case slug"),
  claim: claimSchema,
  category: categorySchema,
  scope: scopeSchema,
  evidence: z.string().max(EVIDENCE_MAX_CHARS),
  confidence: z.number().min(0).max(1),
  provenance: provenanceSchema,
  status: statusSchema,
  supersedes: z.array(z.string()).optional(),
});
export type Signpost = z.infer<typeof signpostSchema>;
