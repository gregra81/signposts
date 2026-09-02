// Zod schema for the config block in 12-wire-contracts.md ("## Config"),
// shape and defaults exact. Every default traces back to a named export
// in ./constants.ts — this module declares no literal of its own beyond
// the wire contract's `version: 1`. Types are derived from the schema
// (SignpostsConfig), not hand-declared alongside it.

import { z } from "zod";
import {
  ALLOW_REMOTE_MODELS,
  AUTH_CHAIN,
  AUTH_METHOD_AUTO,
  AUTO_MERGE,
  AUTO_PUBLISH_CONFIDENCE,
  BOOTSTRAP_AGE_DAYS,
  BOOTSTRAP_GATE_ALL,
  BOOTSTRAP_MAX_OPS,
  BRANCH_PATTERN,
  HEDGE_CONFIDENCE_CAP,
  IDLE_HOURS,
  MAX_AGE_DAYS,
  MODEL_CLASSIFY,
  MODEL_DEFAULT,
  MODEL_EXTRACT,
  NEIGHBOUR_K,
} from "./constants.ts";

// `auto` walks AUTH_CHAIN (see src/core/credentials/chain.ts); naming a
// method pins it, which is how someone holding both a Claude subscription
// and a console API account chooses which one gets billed.
const authSchema = z.object({
  method: z.enum([AUTH_METHOD_AUTO, ...AUTH_CHAIN]).default(AUTH_METHOD_AUTO),
});

const modelsSchema = z.object({
  extract: z.string().default(MODEL_EXTRACT),
  critic: z.string().default(MODEL_DEFAULT),
  classify: z.string().default(MODEL_CLASSIFY),
  resolve: z.string().default(MODEL_DEFAULT),
});

const thresholdsSchema = z.object({
  auto_publish_confidence: z.number().default(AUTO_PUBLISH_CONFIDENCE),
  hedge_confidence_cap: z.number().default(HEDGE_CONFIDENCE_CAP),
  idle_hours: z.number().default(IDLE_HOURS),
  max_age_days: z.number().default(MAX_AGE_DAYS),
});

const bootstrapSchema = z.object({
  age_days: z.number().default(BOOTSTRAP_AGE_DAYS),
  max_ops: z.number().default(BOOTSTRAP_MAX_OPS),
  gate_all_to_human: z.boolean().default(BOOTSTRAP_GATE_ALL),
});

const retrievalSchema = z.object({
  k: z.number().default(NEIGHBOUR_K),
  allow_remote_models: z.boolean().default(ALLOW_REMOTE_MODELS),
  local_model_path: z.string().nullable().default(null),
});

const gitSchema = z.object({
  branch_pattern: z.string().default(BRANCH_PATTERN),
  auto_merge: z.boolean().default(AUTO_MERGE),
});

// The nested blocks are `.optional()` here (rather than `.default({})`)
// and filled in by the `.transform()` below by parsing `{}` through the
// block's own schema. Every field inside each block already carries its
// own `.default()`, so an object-level default is unnecessary — and
// zod's typed `.default()` overload on an object schema does not accept
// a partial literal like `{}` as its argument.
const rawConfigSchema = z.object({
  version: z.literal(1).default(1),
  auth: authSchema.optional(),
  models: modelsSchema.optional(),
  thresholds: thresholdsSchema.optional(),
  bootstrap: bootstrapSchema.optional(),
  retrieval: retrievalSchema.optional(),
  git: gitSchema.optional(),
});

export const configSchema = rawConfigSchema.transform((raw) => ({
  version: raw.version,
  auth: authSchema.parse(raw.auth ?? {}),
  models: modelsSchema.parse(raw.models ?? {}),
  thresholds: thresholdsSchema.parse(raw.thresholds ?? {}),
  bootstrap: bootstrapSchema.parse(raw.bootstrap ?? {}),
  retrieval: retrievalSchema.parse(raw.retrieval ?? {}),
  git: gitSchema.parse(raw.git ?? {}),
}));

export type SignpostsConfig = z.infer<typeof configSchema>;
