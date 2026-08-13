// Layers every signposts tunable, lowest to highest precedence: built-in
// constants -> repo file (.signposts/config.yaml) -> user file
// (~/.signposts/config.yaml) -> environment variables. Returns one frozen
// object, including the derived state paths.
//
// File contents, env, and homeDir all arrive as explicit arguments — this
// function reads no ambient state itself (no `fs`, no `process.env`, no
// `os.homedir()`). Missing files are simply `undefined`, not an error;
// malformed YAML or a schema violation is.

import { parse as parseYaml } from "yaml";
import { configSchema, type SignpostsConfig } from "./schema.ts";
import { mergeLeaves } from "./merge.ts";
import { parseEnvLayer } from "./env.ts";
import { derivePaths, type DerivedPaths } from "./paths.ts";
import { formatZodError } from "../errors/format-zod-error.ts";

export interface ResolveConfigInput {
  /** Absolute path to the repository root whose state is being resolved. */
  repoRoot: string;
  /** The caller's home directory (in place of calling `os.homedir()`). */
  homeDir: string;
  /** Raw YAML text of `.signposts/config.yaml`, if the file exists. */
  repoFileContents?: string | undefined;
  /** Raw YAML text of `~/.signposts/config.yaml`, if the file exists. */
  userFileContents?: string | undefined;
  /** In place of reading `process.env` directly. */
  env: Readonly<Record<string, string | undefined>>;
}

export type ResolvedConfig = Readonly<SignpostsConfig & { paths: DerivedPaths }>;

function parseYamlLayer(contents: string | undefined, label: string): Record<string, unknown> {
  if (contents === undefined) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(contents);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Malformed YAML in ${label}: ${message}`);
  }

  if (parsed === null) {
    // An empty file (or one that's only comments/whitespace) parses to
    // null — treat as "sets nothing".
    return {};
  }

  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Malformed YAML in ${label}: expected a top-level mapping`);
  }

  // A section header with every key commented out (e.g. "retrieval:\n  #
  // k: 6\n") parses to `{ retrieval: null }`, not an absent key — the
  // same "sets nothing" case as a null document, just one level down.
  // This normalisation is scoped to keys the schema defines as an object
  // section, so a top-level scalar leaf (just "version") isn't affected.
  const sections = parsed as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(sections)) {
    const value = sections[key];
    normalized[key] = value === null && Object.hasOwn(OBJECT_SECTION_KEYS, key) ? {} : value;
  }
  return normalized;
}

// Top-level keys the schema defines as an object section. Property keys
// are exempt from signposts/no-magic-literal, so this is written as an
// object rather than an array — "models" would otherwise collide with
// MODEL_CACHE_DIRNAME's value if it appeared as a plain array element.
const OBJECT_SECTION_KEYS: Readonly<Record<string, true>> = {
  models: true,
  thresholds: true,
  bootstrap: true,
  retrieval: true,
  git: true,
};

export function resolveConfig(input: ResolveConfigInput): ResolvedConfig {
  const repoLayer = parseYamlLayer(input.repoFileContents, "repo config (.signposts/config.yaml)");
  const userLayer = parseYamlLayer(input.userFileContents, "user config (~/.signposts/config.yaml)");
  const envLayer = parseEnvLayer(input.env);

  // Constants enter via the schema's own defaults (configSchema.parse({})
  // fills every leaf from a ./constants.ts export), so there is no
  // separate "defaults" object here duplicating those values.
  const merged = mergeLeaves(mergeLeaves(mergeLeaves({}, repoLayer), userLayer), envLayer);

  const result = configSchema.safeParse(merged);
  if (!result.success) {
    throw new Error(`Invalid signposts config:\n${formatZodError(result.error)}`);
  }

  const config = result.data;

  // git.auto_merge is parsed but not configurable: true is forced back to
  // false with a warning; false is silent.
  let git = config.git;
  if (git.auto_merge) {
    console.warn("git.auto_merge is not configurable and has been forced to false.");
    git = { ...git, auto_merge: false };
  }

  const paths = derivePaths(input.repoRoot, input.homeDir);

  return Object.freeze({ ...config, git, paths });
}
