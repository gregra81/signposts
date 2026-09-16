// Environment-variable layer — highest precedence in the config merge.
//
// Naming convention: `SIGNPOSTS_` + the dotted schema path, uppercased,
// with `.` replaced by `_`. E.g. `retrieval.k` -> `SIGNPOSTS_RETRIEVAL_K`.
// Values are coerced to the schema leaf's type.

export type EnvType = "number" | "boolean" | "string";

export interface LeafMapping {
  readonly envVar: string;
  readonly leaf: string;
  readonly type: EnvType;
}

// Grouped by top-level schema section so each section name appears only as an
// object key — one of which, MODEL_CACHE_DIRNAME, happens to share a spelling
// with a constants.ts value; property keys are exempt from
// signposts/no-magic-literal, unlike a bare array element would be.
const SECTION_MAPPINGS: Readonly<Record<string, readonly LeafMapping[]>> = {
  thresholds: [
    {
      envVar: "SIGNPOSTS_THRESHOLDS_AUTO_PUBLISH_CONFIDENCE",
      leaf: "auto_publish_confidence",
      type: "number",
    },
    {
      envVar: "SIGNPOSTS_THRESHOLDS_HEDGE_CONFIDENCE_CAP",
      leaf: "hedge_confidence_cap",
      type: "number",
    },
    { envVar: "SIGNPOSTS_THRESHOLDS_IDLE_HOURS", leaf: "idle_hours", type: "number" },
    { envVar: "SIGNPOSTS_THRESHOLDS_MAX_AGE_DAYS", leaf: "max_age_days", type: "number" },
  ],
  bootstrap: [
    { envVar: "SIGNPOSTS_BOOTSTRAP_AGE_DAYS", leaf: "age_days", type: "number" },
    { envVar: "SIGNPOSTS_BOOTSTRAP_MAX_OPS", leaf: "max_ops", type: "number" },
    {
      envVar: "SIGNPOSTS_BOOTSTRAP_GATE_ALL_TO_HUMAN",
      leaf: "gate_all_to_human",
      type: "boolean",
    },
  ],
  retrieval: [
    { envVar: "SIGNPOSTS_RETRIEVAL_K", leaf: "k", type: "number" },
    {
      envVar: "SIGNPOSTS_RETRIEVAL_ALLOW_REMOTE_MODELS",
      leaf: "allow_remote_models",
      type: "boolean",
    },
    {
      envVar: "SIGNPOSTS_RETRIEVAL_LOCAL_MODEL_PATH",
      leaf: "local_model_path",
      type: "string",
    },
  ],
  git: [
    { envVar: "SIGNPOSTS_GIT_BRANCH_PATTERN", leaf: "branch_pattern", type: "string" },
    { envVar: "SIGNPOSTS_GIT_AUTO_MERGE", leaf: "auto_merge", type: "boolean" },
  ],
};

// Not `SIGNPOSTS_VERSION`. docs/install.sh documents that name as the release
// to pin, and this layer used to read it as the config schema version — a
// number — so a developer who exported the pin the installer told them about
// got a stack trace out of every command, doctor included
// (19-value-to-a-user.md item 5). The installer's use is the published one.
const TOP_LEVEL_MAPPING = { envVar: "SIGNPOSTS_CONFIG_VERSION", leaf: "version", type: "number" } as const;

function coerce(raw: string, type: EnvType, envVar: string): unknown {
  switch (type) {
    case "string":
      return raw;
    case "number": {
      if (raw.trim() === "") {
        // `FOO=` (empty) is the standard CI way to say "unset" — without
        // this, `Number("")` is 0, and a threshold/count field would
        // reject it as "too small" instead of naming the real problem.
        throw new Error(`${envVar} is set but empty`);
      }
      const value = Number(raw);
      if (Number.isNaN(value) || !Number.isFinite(value)) {
        throw new Error(`${envVar}: "${raw}" is not a valid number`);
      }
      return value;
    }
    case "boolean": {
      if (raw === "true") return true;
      if (raw === "false") return false;
      throw new Error(`${envVar}: "${raw}" is not a valid boolean (expected "true" or "false")`);
    }
  }
}

/**
 * Builds the partial config tree carried by the environment layer.
 * Only recognised `SIGNPOSTS_*` variables are consulted; anything else in
 * `env` is ignored rather than rejected, since this layer never grows an
 * unbounded set of keys the way the YAML layers can.
 */
export function parseEnvLayer(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, unknown> {
  const layer: Record<string, unknown> = {};

  const topRaw = env[TOP_LEVEL_MAPPING.envVar];
  if (topRaw !== undefined) {
    layer[TOP_LEVEL_MAPPING.leaf] = coerce(topRaw, TOP_LEVEL_MAPPING.type, TOP_LEVEL_MAPPING.envVar);
  }

  for (const [section, mappings] of Object.entries(SECTION_MAPPINGS)) {
    let sectionLayer: Record<string, unknown> | undefined;
    for (const mapping of mappings) {
      const raw = env[mapping.envVar];
      if (raw === undefined) {
        continue;
      }
      sectionLayer ??= {};
      sectionLayer[mapping.leaf] = coerce(raw, mapping.type, mapping.envVar);
    }
    if (sectionLayer !== undefined) {
      layer[section] = sectionLayer;
    }
  }

  return layer;
}
