// The reasoning half of the resolver's three read-only tools: what to ask
// git for, how to read what it said back, and how to shape a result the
// model can use. No filesystem, no subprocess — src/io/tools/repo-tools.ts
// supplies both and does nothing else.
//
// The split is not tidiness. This is where the caps live, where a grep exit
// status is turned into "no matches" rather than "failed", and where a
// commit line becomes a commit. Each of those is a decision that can be
// wrong in a way a type will not catch, and core is the half the mutation
// gate grades.

import path from "node:path";
import { JSON_INDENT } from "../config/constants.ts";
import type { ToolResult } from "../model/types.ts";

/**
 * Ceiling on what one tool result may add to the conversation. A resolve turn
 * carries two claims and up to MAX_RESOLVE_TOOL_ITERATIONS results; an
 * unbounded `read_file` on a lockfile would crowd out the claims it was
 * fetched to adjudicate, and the model pays for every token of it.
 */
export const MAX_TOOL_RESULT_CHARS = 20_000;

/** `git log` when the model names no limit, and the ceiling when it names one. */
export const DEFAULT_GIT_LOG_LIMIT = 25;
export const MAX_GIT_LOG_LIMIT = 250;

/** Matches beyond this are dropped. */
export const MAX_GREP_MATCHES = 150;

/**
 * Field separator inside `git log --pretty`. ASCII unit separator: it cannot
 * occur in a commit subject, so splitting on it can never be fooled by a
 * subject line that contains whatever delimiter looked safe.
 */
const FIELD_SEP = "\u001F";

/** A tool result, truncated if it would flood the conversation. */
export function ok(content: string): ToolResult {
  return {
    content:
      content.length > MAX_TOOL_RESULT_CHARS
        ? `${content.slice(0, MAX_TOOL_RESULT_CHARS)}\n…truncated at ${MAX_TOOL_RESULT_CHARS} characters.`
        : content,
    isError: false,
  };
}

/** A tool result the model should read and correct from, never a thrown error. */
export function failed(reason: string): ToolResult {
  return { content: reason, isError: true };
}

/**
 * git's own complaint, appended to a failure so the model can correct it.
 *
 * Found by running the resolver against a live model: it opened with the PCRE
 * pattern `(?i)(read[-_ ]?only|...)`, which POSIX ERE rejects, and the reply
 * was the bare `git grep exited 128`. Nothing in that says the regex dialect
 * was the problem, so the recovery was a guess and it cost an iteration of a
 * budget that only has six.
 */
export function withStderr(message: string, stderr: string): string {
  const detail = stderr.trim();
  return detail === "" ? message : `${message}: ${detail}`;
}

/**
 * A 1-based, inclusive slice, numbered so the lines in the result are the
 * lines a person would cite back.
 *
 * An `endLine` past the end of the file clamps rather than fails: the model
 * is guessing at a range, and half a slice answers its question better than
 * a rejection does. A range that runs backwards is a different thing — it
 * means the model has the two arguments confused, and silently swapping them
 * would hide that.
 */
export function sliceLines(
  contents: string,
  startLine: number | undefined,
  endLine: number | undefined,
): ToolResult {
  if (startLine === undefined && endLine === undefined) {
    return ok(contents);
  }
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

/**
 * A pathspec argument for git, derived from the *resolved* path rather than
 * from the model's string, and relative to the confined root because that is
 * where git runs. An argument naming the root itself becomes `.`.
 */
export function pathspecFor(root: string, target: string): string[] {
  return ["--", path.relative(root, target) || "."];
}

/** The argv for a `git log`, given an already-confined pathspec. */
export function gitLogArgs(limit: number | undefined, pathspec: readonly string[]): string[] {
  const count = Math.min(limit ?? DEFAULT_GIT_LOG_LIMIT, MAX_GIT_LOG_LIMIT);
  return [
    "log",
    `--max-count=${count}`,
    `--pretty=format:%H${FIELD_SEP}%an${FIELD_SEP}%aI${FIELD_SEP}%s`,
    ...pathspec,
  ];
}

/** The argv for a `git grep`, given an already-confined pathspec. */
export function grepArgs(pattern: string, pathspec: readonly string[]): string[] {
  return [
    "grep",
    "--line-number",
    "--no-color",
    "-I",
    "--extended-regexp",
    `--max-count=${MAX_GREP_MATCHES}`,
    "-e",
    pattern,
    ...pathspec,
  ];
}

/** `git log`'s output as JSON, or the reason it could not be read. */
export function parseGitLog(status: number, stdout: string, stderr: string): ToolResult {
  if (status !== 0) {
    return failed(withStderr(`git_log: git log exited ${status}`, stderr));
  }
  const commits = stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [hash, author, date, ...subject] = line.split(FIELD_SEP);
      // The subject is rejoined rather than taken as [3]: a separator cannot
      // appear in a commit subject, but a subject containing one would
      // otherwise be silently truncated instead of coming back whole.
      return { hash, author, date, subject: subject.join(FIELD_SEP) };
    });
  return ok(JSON.stringify(commits, null, JSON_INDENT));
}

/**
 * `git grep`'s output, or the reason it could not be read.
 *
 * Exit 1 means "no matches", which is an answer and often the one that
 * settles the contradiction. Anything above 1 is git itself objecting — a bad
 * regex, a pathspec matching nothing tracked — and the model needs to hear
 * which.
 */
export function parseGrep(
  pattern: string,
  status: number,
  stdout: string,
  stderr: string,
): ToolResult {
  if (status > 1) {
    return failed(withStderr(`grep_repo: git grep exited ${status}`, stderr));
  }
  const matches = stdout.split("\n").filter((line) => line !== "");
  if (matches.length === 0) {
    return ok(`no matches for ${pattern}`);
  }
  return ok(matches.slice(0, MAX_GREP_MATCHES).join("\n"));
}
