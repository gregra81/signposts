// The three read-only tools `resolve_conflict` actually runs
// (12-wire-contracts.md, "Tools (Phase 4.5)").
//
// **The whole point of this module is the confinement check.** Every argument
// that reaches it was written by a model reasoning about a contradiction, and
// a model that has been told a claim is about `../../etc` will happily ask to
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
import path from "node:path";
import { confine } from "../../core/paths/confine.ts";
import {
  RESOLVE_TOOL_INPUT_SCHEMAS,
  RESOLVE_TOOL_NAMES,
} from "../../core/graph/resolve-tools.ts";
import { JSON_INDENT } from "../../core/config/constants.ts";
import type { ResolveToolName } from "../../core/graph/resolve-tools.ts";
import type { ToolResult, ToolRunner } from "../../core/model/types.ts";

/**
 * Ceiling on what one tool result may add to the conversation. A resolve turn
 * carries two claims and up to MAX_RESOLVE_TOOL_ITERATIONS results; an
 * unbounded `read_file` on a lockfile would crowd out the claims it was
 * fetched to adjudicate, and the model pays for every token of it.
 */
const MAX_TOOL_RESULT_CHARS = 20_000;

/** `git log` when the model names no limit, and the ceiling when it names one. */
const DEFAULT_GIT_LOG_LIMIT = 25;
const MAX_GIT_LOG_LIMIT = 250;

/** Matches beyond this are dropped. */
const MAX_GREP_MATCHES = 150;

/**
 * Wall-clock cap on one `git` invocation, so a pathological pattern or a
 * repository on a stalled network mount cannot hang the run.
 */
const GIT_TIMEOUT_MS = 15_000;

/**
 * Field separator inside `git log --pretty`. ASCII unit separator: it cannot
 * occur in a commit subject, so splitting on it can never be fooled by a
 * subject line that contains whatever delimiter looked safe.
 */
const FIELD_SEP = "\u001F";

function ok(content: string): ToolResult {
  return {
    content:
      content.length > MAX_TOOL_RESULT_CHARS
        ? `${content.slice(0, MAX_TOOL_RESULT_CHARS)}\n…truncated at ${MAX_TOOL_RESULT_CHARS} characters.`
        : content,
    isError: false,
  };
}

function failed(reason: string): ToolResult {
  return { content: reason, isError: true };
}

/**
 * The confined absolute path for one model-supplied argument, or the failure
 * to hand back. Every filesystem-touching branch below starts here.
 */
function confined(repoRoot: string, candidate: string): { path: string } | ToolResult {
  const result = confine(repoRoot, candidate);
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

/**
 * git's own complaint, appended to a failure so the model can correct it.
 *
 * Found by running this against a live model: it opened with the PCRE
 * pattern `(?i)(read[-_ ]?only|...)`, which POSIX ERE rejects, and the reply
 * was the bare `git grep exited 128`. Nothing in that says the regex dialect
 * was the problem, so the recovery was a guess and it cost an iteration of a
 * budget that only has six.
 */
function withStderr(message: string, stderr: string): string {
  const detail = stderr.trim();
  return detail === "" ? message : `${message}: ${detail}`;
}

/**
 * A pathspec argument for git, derived from the *resolved* path rather than
 * from the model's string, and relative to the confined root because that is
 * where git runs. An argument naming the root itself becomes `.`.
 */
function pathspecFor(root: string, target: string): string[] {
  return ["--", path.relative(root, target) || "."];
}

function readFileTool(repoRoot: string, input: unknown): ToolResult {
  const parsed = RESOLVE_TOOL_INPUT_SCHEMAS[RESOLVE_TOOL_NAMES.readFile].safeParse(input);
  if (!parsed.success) {
    return failed(`read_file: invalid arguments: ${parsed.error.message}`);
  }
  const { path: candidate, startLine, endLine } = parsed.data;

  const target = confined(repoRoot, candidate);
  if (isFailure(target)) return target;

  let contents: string;
  try {
    if (fs.statSync(target.path).isDirectory()) {
      return failed(`read_file: ${candidate} is a directory`);
    }
    contents = fs.readFileSync(target.path, "utf8");
  } catch (err) {
    return failed(`read_file: ${candidate}: ${(err as Error).message}`);
  }

  if (startLine === undefined && endLine === undefined) {
    return ok(contents);
  }

  // 1-based and inclusive, so the numbers in the result are the numbers a
  // person would cite back. An endLine past the end of the file is a clamp,
  // not an error: the model is guessing at a range, and half a slice answers
  // its question better than a rejection does.
  const lines = contents.split("\n");
  const from = startLine ?? 1;
  const to = endLine ?? lines.length;
  if (to < from) {
    return failed(`read_file: endLine ${to} is before startLine ${from}`);
  }
  return ok(
    lines
      .slice(from - 1, to)
      .map((line, offset) => `${from + offset}: ${line}`)
      .join("\n"),
  );
}

function gitLogTool(repoRoot: string, input: unknown): ToolResult {
  const parsed = RESOLVE_TOOL_INPUT_SCHEMAS[RESOLVE_TOOL_NAMES.gitLog].safeParse(input);
  if (!parsed.success) {
    return failed(`git_log: invalid arguments: ${parsed.error.message}`);
  }
  const { path: candidate, limit } = parsed.data;

  // The root is confined even when the model named no path: `git log` with no
  // pathspec still runs somewhere, and that somewhere must be the real root.
  const root = confined(repoRoot, ".");
  if (isFailure(root)) return root;

  let pathspec: string[] = [];
  if (candidate !== undefined) {
    const target = confined(repoRoot, candidate);
    if (isFailure(target)) return target;
    pathspec = pathspecFor(root.path, target.path);
  }

  const count = Math.min(limit ?? DEFAULT_GIT_LOG_LIMIT, MAX_GIT_LOG_LIMIT);
  const result = git(root.path, [
    "log",
    `--max-count=${count}`,
    `--pretty=format:%H${FIELD_SEP}%an${FIELD_SEP}%aI${FIELD_SEP}%s`,
    ...pathspec,
  ]);
  if (isFailure(result)) return result;
  if (result.status !== 0) {
    return failed(withStderr(`git_log: git log exited ${result.status}`, result.stderr));
  }

  const commits = result.stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [hash, author, date, ...subject] = line.split(FIELD_SEP);
      return { hash, author, date, subject: subject.join(FIELD_SEP) };
    });
  return ok(JSON.stringify(commits, null, JSON_INDENT));
}

function grepRepoTool(repoRoot: string, input: unknown): ToolResult {
  const parsed = RESOLVE_TOOL_INPUT_SCHEMAS[RESOLVE_TOOL_NAMES.grepRepo].safeParse(input);
  if (!parsed.success) {
    return failed(`grep_repo: invalid arguments: ${parsed.error.message}`);
  }
  const { pattern, glob } = parsed.data;

  const root = confined(repoRoot, ".");
  if (isFailure(root)) return root;

  let pathspec: string[] = [];
  if (glob !== undefined) {
    // A glob is a path too. `src/config/*.ts` resolves to a non-existent leaf
    // under the root, which confine() accepts by resolving its longest
    // existing ancestor; `../other/*` escapes and is rejected here rather
    // than being handed to git as a pathspec.
    const target = confined(repoRoot, glob);
    if (isFailure(target)) return target;
    pathspec = pathspecFor(root.path, target.path);
  }

  const result = git(root.path, [
    "grep",
    "--line-number",
    "--no-color",
    "-I",
    "--extended-regexp",
    `--max-count=${MAX_GREP_MATCHES}`,
    "-e",
    pattern,
    ...pathspec,
  ]);
  if (isFailure(result)) return result;

  // git grep exits 1 for "no matches", which is an answer, not a failure —
  // often the answer that settles the contradiction. Anything above 1 is git
  // itself objecting (a bad regex, a pathspec matching nothing tracked).
  if (result.status > 1) {
    return failed(withStderr(`grep_repo: git grep exited ${result.status}`, result.stderr));
  }

  const matches = result.stdout.split("\n").filter((line) => line !== "");
  if (matches.length === 0) {
    return ok(`no matches for ${pattern}`);
  }
  return ok(matches.slice(0, MAX_GREP_MATCHES).join("\n"));
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
