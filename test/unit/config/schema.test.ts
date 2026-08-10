import { describe, expect, it } from "vitest";
import { configSchema } from "../../../src/core/config/schema.js";
import {
  ALLOW_REMOTE_MODELS,
  AUTO_MERGE,
  AUTO_PUBLISH_CONFIDENCE,
  BOOTSTRAP_AGE_DAYS,
  BOOTSTRAP_GATE_ALL,
  BOOTSTRAP_MAX_OPS,
  BRANCH_PATTERN,
  HEDGE_CONFIDENCE_CAP,
  IDLE_HOURS,
  MAX_AGE_DAYS,
  MODEL_DEFAULT,
  NEIGHBOUR_K,
} from "../../../src/core/config/constants.js";

describe("configSchema", () => {
  it("parsing {} fills every leaf from the constants module", () => {
    expect(configSchema.parse({})).toEqual({
      version: 1,
      models: {
        extract: MODEL_DEFAULT,
        critic: MODEL_DEFAULT,
        classify: MODEL_DEFAULT,
        resolve: MODEL_DEFAULT,
      },
      thresholds: {
        auto_publish_confidence: AUTO_PUBLISH_CONFIDENCE,
        hedge_confidence_cap: HEDGE_CONFIDENCE_CAP,
        idle_hours: IDLE_HOURS,
        max_age_days: MAX_AGE_DAYS,
      },
      bootstrap: {
        age_days: BOOTSTRAP_AGE_DAYS,
        max_ops: BOOTSTRAP_MAX_OPS,
        gate_all_to_human: BOOTSTRAP_GATE_ALL,
      },
      retrieval: {
        k: NEIGHBOUR_K,
        allow_remote_models: ALLOW_REMOTE_MODELS,
        local_model_path: null,
      },
      git: {
        branch_pattern: BRANCH_PATTERN,
        auto_merge: AUTO_MERGE,
      },
    });
  });

  it("accepts a partial override at a single leaf, keeping everything else defaulted", () => {
    const parsed = configSchema.parse({ retrieval: { k: 10 } });
    expect(parsed.retrieval).toEqual({
      k: 10,
      allow_remote_models: ALLOW_REMOTE_MODELS,
      local_model_path: null,
    });
  });

  it("rejects a config with an unsupported version", () => {
    const result = configSchema.safeParse({ version: 2 });
    expect(result.success).toBe(false);
  });
});
