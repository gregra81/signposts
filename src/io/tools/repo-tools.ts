// The effects half of the resolver's three read-only tools: `confine()`, one
// `statSync`/`readFileSync`, and one `spawnSync("git", …)`. Everything that
// decides anything — the caps, the argv, the exit-status semantics, the line
// slicing, the parsing — is in src/core/tools/repo-tools.ts.
//
// **The confinement check is the point of this file.** Every argument that
// reaches it was written by a model reasoning about a contradiction, and a
// model that has been told a claim is about `../../etc` will happily ask to
// read it. RESOLVE_SYSTEM says the tools are read-only and confined, but a
// prompt is a request, not a boundary: the boundary is confine(), called here
// on every path — the file, the git pathspec, the grep pathspec, and the
// repository root itself — before any syscall that could touch what the path
// names. There is no route through this file that reaches the filesystem
// without going through it first.
//
// Nothing here throws for anything the model did. An unknown tool, arguments
// that fail their schema, a path outside the repository, a file that does not
// exist: each comes back as `{ isError: true, content }`, which the provider
// turns into a tool_result the model can read and correct from. Throwing
// would fail the whole run over one bad guess, and the bounded loop exists
// precisely so a bad guess costs one iteration.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { confine } from "../../core/paths/confine.ts";
import { nodePathFacts } from "../paths/node-path-facts.ts";
import {
  MAX_TOOL_RESULT_CHARS,
  failed,
  gitLogArgs,
  grepArgs,
  parseGitLog,
  parseGrep,
  pathspecFor,
  sliceLines,
} from "../../core/tools/repo-tools.ts";
import {
  RESOLVE_TOOL_INPUT_SCHEMAS,
  RESOLVE_TOOL_NAMES,
} from "../../core/graph/resolve-tools.ts";
import type { ResolveToolName } from "../../core/graph/resolve-tools.ts";
import type { ToolResult, ToolRunner } from "../../core/model/types.ts";

/**
 * Wall-clock cap on one `git` invocation, so a pathological pattern or a
 * repository on a stalled network mount cannot hang the run.
 */
const GIT_TIMEOUT_MS = 15_000;

/**
 * The confined absolute path for one model-supplied argument, or the failure
 * to hand back. Every filesystem-touching branch below starts here.
 */
function confined(repoRoot: string, candidate: string): { path: string } | ToolResult {
  const result = confine(repoRoot, candidate, nodePathFacts);
  return result.ok ? { path: result.path } : failed(`rejected: ${result.reason}`);
}

/** Narrows the "or the failure to hand back" half of a result union. */
function isFailure<T extends object>(value: T | ToolResult): value is ToolResult {
  return "isError" in value;
}

/**
 * `git`, run inside the confined repository root.
 *
 * `cwd` is the *confined* root, never the caller's string, so a repoRoot that
 * is itself a symlink out of the tree cannot be used to run git somewhere
 * else. Arguments go through spawnSync's array form — no shell — so a pattern
 * containing `;` or backticks is a pattern, not a command.
 */
function git(
  root: string,
  args: readonly string[],
): { status: number; stdout: string; stderr: string } | ToolResult {
  const result = spawnSync("git", [...args], {
    cwd: root,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_TOOL_RESULT_CHARS,
  });
  if (result.error) {
    return failed(`git could not be run: ${result.error.message}`);
  }
  // `status` is null when the child was killed by a signal — the timeout
  // above being the case that matters. Reported as a failure rather than
  // read as a zero exit with empty output.
  if (result.status === null) {
    return failed(`git did not finish within ${GIT_TIMEOUT_MS}ms`);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The confined root, plus the pathspec for an optional model-supplied path. */
function rootAndPathspec(
  repoRoot: string,
  candidate: string | undefined,
): { root: string; pathspec: string[] } | ToolResult {
  // The root is confined even when the model named no path: git still runs
  // somewhere, and that somewhere must be the real root.
  const root = confined(repoRoot, ".");
  if (isFailure(root)) return root;
  if (candidate === undefined) {
    return { root: root.path, pathspec: [] };
  }
  const target = confined(repoRoot, candidate);
  if (isFailure(target)) return target;
  return { root: root.path, pathspec: pathspecFor(root.path, target.path) };
}

function readFileTool(repoRoot: string, input: unknown): ToolResult {
  const parsed = RESOLVE_TOOL_INPUT_SCHEMAS[RESOLVE_TOOL_NAMES.readFile].safeParse(input);
  if (!parsed.success) {
    return failed(`read_file: invalid arguments: ${parsed.error.message}`);
  }
  const { path: candidate, startLine, endLine } = parsed.data;

  const target = confined(repoRoot, candidate);
  if (isFailure(target)) return target;

  try {
    if (fs.statSync(target.path).isDirectory()) {
      return failed(`read_file: ${candidate} is a directory`);
    }
    return sliceLines(fs.readFileSync(target.path, "utf8"), startLine, endLine);
  } catch (err) {
    return failed(`read_file: ${candidate}: ${(err as Error).message}`);
  }
}

function gitLogTool(repoRoot: string, input: unknown): ToolResult {
  const parsed = RESOLVE_TOOL_INPUT_SCHEMAS[RESOLVE_TOOL_NAMES.gitLog].safeParse(input);
  if (!parsed.success) {
    return failed(`git_log: invalid arguments: ${parsed.error.message}`);
  }
  const { path: candidate, limit } = parsed.data;

  const where = rootAndPathspec(repoRoot, candidate);
  if (isFailure(where)) return where;

  const result = git(where.root, gitLogArgs(limit, where.pathspec));
  if (isFailure(result)) return result;
  return parseGitLog(result.status, result.stdout, result.stderr);
}

function grepRepoTool(repoRoot: string, input: unknown): ToolResult {
  const parsed = RESOLVE_TOOL_INPUT_SCHEMAS[RESOLVE_TOOL_NAMES.grepRepo].safeParse(input);
  if (!parsed.success) {
    return failed(`grep_repo: invalid arguments: ${parsed.error.message}`);
  }
  const { pattern, glob } = parsed.data;

  // A glob is a path too. `src/config/*.ts` resolves to a non-existent leaf
  // under the root, which confine() accepts by resolving its longest existing
  // ancestor; `../other/*` escapes and is rejected here rather than being
  // handed to git as a pathspec.
  const where = rootAndPathspec(repoRoot, glob);
  if (isFailure(where)) return where;

  const result = git(where.root, grepArgs(pattern, where.pathspec));
  if (isFailure(result)) return result;
  return parseGrep(pattern, result.status, result.stdout, result.stderr);
}

const TOOLS: Readonly<
  Record<ResolveToolName, (repoRoot: string, input: unknown) => ToolResult>
> = {
  [RESOLVE_TOOL_NAMES.readFile]: readFileTool,
  [RESOLVE_TOOL_NAMES.gitLog]: gitLogTool,
  [RESOLVE_TOOL_NAMES.grepRepo]: grepRepoTool,
};

function isToolName(name: string): name is ResolveToolName {
  return Object.hasOwn(TOOLS, name);
}

/**
 * A `ToolRunner` bound to one repository checkout, for one resolve call.
 *
 * `repoRoot` comes from graph state, which the run was started with — it is
 * not something the model can influence. Everything the model *can* influence
 * is an argument, and every one of those is confined against this root.
 */
export function makeRepoToolRunner(repoRoot: string): ToolRunner {
  return async (name, input) => {
    if (!isToolName(name)) {
      return failed(`unknown tool: ${name}`);
    }
    return TOOLS[name](repoRoot, input);
  };
}
