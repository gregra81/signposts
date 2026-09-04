// The three read-only tools `resolve_conflict` is given at Phase 4.5, as
// contracts rather than implementations (12-wire-contracts.md, "Tools").
//
// Names and input shapes are the doc's:
//
//   read_file  { path: string; startLine?: number; endLine?: number }
//   git_log    { path?: string; limit?: number }
//   grep_repo  { pattern: string; glob?: string }
//
// They live in core because they are data — a name, a sentence, a schema —
// and because RESOLVE_SYSTEM already promises the model these three names by
// hand (src/core/prompts/system.ts). A tool renamed here and not there is a
// prompt that advertises a tool the model cannot call, so the names have one
// home and test/invariant checks the prompt against it.
//
// Nothing here touches the filesystem. Every argument below is untrusted
// model output, and the confinement that makes it safe happens in
// src/io/tools/repo-tools.ts, immediately before the syscall — not here, and
// not in the prompt.

import { z } from "zod";
import { toOutputFormatSchema } from "../model/output-schema.ts";
import type { ToolDef } from "../model/types.ts";

/** The three tool names, spelled once. RESOLVE_SYSTEM names the same three. */
export const RESOLVE_TOOL_NAMES = {
  readFile: "read_file",
  gitLog: "git_log",
  grepRepo: "grep_repo",
} as const;

export type ResolveToolName = (typeof RESOLVE_TOOL_NAMES)[keyof typeof RESOLVE_TOOL_NAMES];

// Line numbers are 1-based and inclusive, matching how a person cites a file.
// `.int()` and the lower bounds are real validators: a `startLine` of 0.5 or
// -3 is a model that has misunderstood the tool, and clamping it silently
// would hand back a slice nobody asked for.
const lineNumber = z.number().int().min(1);

export const readFileInputSchema = z
  .object({
    path: z.string(),
    startLine: lineNumber.optional(),
    endLine: lineNumber.optional(),
  })
  .strict();

export const gitLogInputSchema = z
  .object({
    path: z.string().optional(),
    limit: z.number().int().min(1).optional(),
  })
  .strict();

export const grepRepoInputSchema = z
  .object({
    pattern: z.string().min(1),
    glob: z.string().optional(),
  })
  .strict();

/** The schema each tool's arguments are parsed with before anything runs. */
export const RESOLVE_TOOL_INPUT_SCHEMAS = {
  [RESOLVE_TOOL_NAMES.readFile]: readFileInputSchema,
  [RESOLVE_TOOL_NAMES.gitLog]: gitLogInputSchema,
  [RESOLVE_TOOL_NAMES.grepRepo]: grepRepoInputSchema,
} as const satisfies Record<ResolveToolName, z.ZodType>;

/**
 * What the model is told each tool does. Every description says the tool is
 * read-only and confined to the repository, because the model chooses its
 * arguments from these sentences: a description that implies it can reach a
 * sibling checkout produces calls that the confinement check then rejects,
 * and burns an iteration of the bounded loop doing it.
 */
const DESCRIPTIONS: Readonly<Record<ResolveToolName, string>> = {
  [RESOLVE_TOOL_NAMES.readFile]:
    "Read a UTF-8 text file from the repository under review. Paths are relative to the repository root and cannot leave it. Optionally pass startLine and endLine (1-based, inclusive) to read a slice. Read-only.",
  [RESOLVE_TOOL_NAMES.gitLog]:
    "List recent commits in the repository under review, newest first, as JSON with hash, author, date and subject. Pass path to restrict the log to one file or directory inside the repository. Read-only.",
  [RESOLVE_TOOL_NAMES.grepRepo]:
    "Search the tracked contents of the repository under review for a regular expression, returning matching file, line number and line. Pass glob to restrict the search to a path pattern inside the repository. Read-only.",
};

/**
 * The `ToolDef[]` handed to the provider for a `resolve` call.
 *
 * Derived on call rather than held in a module-level constant, for the reason
 * jsonSchemaFor() gives (src/core/graph/node-io.ts): stryker.config sets
 * `ignoreStatic: true`, so a precomputed table's mutants would not be scored.
 */
export function resolveToolDefs(): ToolDef[] {
  return Object.values(RESOLVE_TOOL_NAMES).map((name) => ({
    name,
    description: DESCRIPTIONS[name],
    // The same stripper the output format uses. Tool input schemas accept a
    // wider subset than `output_config.format` does, so this drops a little
    // more than it must — `$schema`, the numeric bounds above — and drops
    // nothing that matters, because the arguments come back through the zod
    // schema those bounds were written on.
    inputSchema: toOutputFormatSchema(z.toJSONSchema(RESOLVE_TOOL_INPUT_SCHEMAS[name])),
  }));
}
