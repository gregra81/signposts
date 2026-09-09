#!/usr/bin/env node
// The `statusLine` command (07-triggering-and-ux.md, "Visibility"): one row in
// Claude Code's persistent bar, showing a run while it is happening and
// nothing at all when there is nothing happening.
//
//     1. read the session JSON Claude Code puts on stdin
//     2. run the developer's own statusLine, if we are wrapping one
//     3. read <STATE_DIR>/status.json — the file the worker and the run
//        commands share
//     4. print a line, but only if it says something true right now
//
// Like `hooks/session-start.ts`, this **imports nothing from `src/`** — the
// third lint rule — and for the same two reasons. It ships pre-compiled
// (`pnpm build:hooks`), so type-stripping is not paid on every render; and it
// runs on a cadence, not once, so dragging in the SQLite bindings and an ONNX
// pipeline to render fifteen characters would be absurd. The constants below
// are a third transcription of 13-constants.md, after `src/core/config` and
// the hook. That is the price of the rule; 13-constants.md stays the
// authority.
//
// **Nothing here opens a database.** Everything on the bar comes from
// `status.json`, which is exactly why that file exists.
//
// Two failure modes shape the error handling, both from the platform docs: a
// non-zero exit blanks the bar, and so does empty output. So every path here
// exits 0, and the wrapped command's output is printed even when our own half
// has nothing to add — a developer who already had a status line must not lose
// it because signposts had a bad day.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Constants — transcribed from 13-constants.md. See the header.
// ---------------------------------------------------------------------------

/** Run progress older than this belongs to a run nothing is finishing. */
const RUN_PROGRESS_STALE_MINUTES = 15;
const MS_PER_MINUTE = 60_000;
const RUN_PROGRESS_STALE_MS = RUN_PROGRESS_STALE_MINUTES * MS_PER_MINUTE;

const SIGNPOSTS_DIRNAME = ".signposts";
const STATUSLINE_FILENAME = "status.json";
const REPO_HASH_LENGTH = 12;

const WORKER_PHASE_RUNNING = "running";

const PREFIX = "🪧 signposts: ";

/**
 * `--wrap <command>`: the statusLine the developer already had.
 *
 * It is an argument rather than a file we keep somewhere, because
 * `.claude/settings.json` is a file people read. A wrapped command that is
 * visible in the setting is one they can see, edit and take back; one hidden
 * in `~/.signposts/` is a line they cannot explain and will not find.
 */
const WRAP_FLAG = "--wrap";

// ---------------------------------------------------------------------------
// State. Same derivation as src/core/config/paths.ts and the hook, which this
// file may not import: sha256 of the repo root, first 12 hex characters.
// ---------------------------------------------------------------------------

function hashRepoRoot(repoRoot: string): string {
  return createHash("sha256").update(repoRoot).digest("hex").slice(0, REPO_HASH_LENGTH);
}

/**
 * Nearest ancestor holding a `.git`, resolved through symlinks, or null.
 *
 * The realpath is the same load-bearing detail as in the hook: the worker
 * derives its own repo root from `process.cwd()`, which Node reports resolved,
 * so a checkout reached through a symlink would have this process reading a
 * `status.json` nothing ever writes.
 */
export function findRepoRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  for (;;) {
    try {
      statSync(path.join(current, ".git"));
      try {
        return realpathSync(current);
      } catch {
        return current;
      }
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
    }
  }
}

/** Where the session is, as Claude Code reports it. `workspace.current_dir` is the documented field; `cwd` is its twin. */
export function sessionDir(stdin: string, fallback: string): string {
  try {
    const parsed: unknown = JSON.parse(stdin);
    if (typeof parsed !== "object" || parsed === null) {
      return fallback;
    }
    const session = parsed as { cwd?: unknown; workspace?: { current_dir?: unknown } };
    const current = session.workspace?.current_dir;
    if (typeof current === "string" && current !== "") {
      return current;
    }
    return typeof session.cwd === "string" && session.cwd !== "" ? session.cwd : fallback;
  } catch {
    return fallback;
  }
}

/**
 * The shape this reads off `status.json`, which is
 * src/core/worker/status.ts's `WorkerStatus`.
 *
 * Every field is optional, because a statusLine and a worker from different
 * versions will meet — the plugin updates as a unit, the state file on disk
 * does not — and a field this build has not learned about must not stop it
 * rendering the ones it has.
 */
export interface RunProgress {
  sessionsDone?: number;
  sessionsTotal?: number;
  found?: number;
  updatedAt?: string;
}

export interface WorkerStatus {
  phase?: string;
  threadsWaiting?: number;
  lastError?: string;
  runProgress?: RunProgress;
}

export function readStatus(statusPath: string): WorkerStatus {
  try {
    const parsed: unknown = JSON.parse(readFileSync(statusPath, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as WorkerStatus) : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// The line. Every branch below is a condition that is true at the moment it
// renders — 07's "gate every notice on there actually being something to say"
// applies twice over to a bar that is on the screen permanently.
// ---------------------------------------------------------------------------

function whole(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The verb agrees with the count too: "1 change needs", "2 changes need". */
function agrees(count: number, verb: string): string {
  return count === 1 ? `${verb}s` : verb;
}

/**
 * Progress is only rendered while something is plausibly still moving it.
 *
 * A run is a sequence of processes, one per halt, and closing the terminal
 * between two of them leaves the last one's progress on disk with nothing to
 * finish it. A bar reading "2/3 sessions" for the rest of the week is worse
 * than an empty one: it is the same claim, and it is false.
 */
function liveProgress(status: WorkerStatus, nowMs: number): RunProgress | undefined {
  const progress = status.runProgress;
  if (progress === undefined || typeof progress.updatedAt !== "string") {
    return undefined;
  }
  const stamped = Date.parse(progress.updatedAt);
  if (Number.isNaN(stamped) || nowMs - stamped >= RUN_PROGRESS_STALE_MS) {
    return undefined;
  }
  return progress;
}

/**
 * What signposts has to say right now, or "" for the common case of nothing.
 *
 * The order is by immediacy, and only one of these renders: a bar is one row
 * shared with whatever else the developer put there, so this earns at most a
 * clause of it. A run in flight outranks a parked review, which outranks a
 * failure nobody has been told about yet.
 */
export function statusLine(status: WorkerStatus, nowMs: number): string {
  // Above the run's progress deliberately. A parked review is the one state
  // where nothing moves until the developer does something, and it is the
  // state that outlasts everything else here — a run halted on one re-stamps
  // no progress, so the progress row would age out and leave the bar blank at
  // exactly the moment it had something to ask for.
  const waiting = whole(status.threadsWaiting);
  if (waiting > 0) {
    return `${PREFIX}${plural(waiting, "change")} ${agrees(waiting, "need")} your review`;
  }

  const progress = liveProgress(status, nowMs);
  if (progress !== undefined) {
    const done = whole(progress.sessionsDone);
    const total = Math.max(done, whole(progress.sessionsTotal));
    const found = whole(progress.found);
    return `${PREFIX}${done}/${total} sessions · ${plural(found, "signpost")}`;
  }

  // The worker only ever reindexes (it cannot answer a model call), so this is
  // the one thing that is genuinely happening in the background. Below the
  // run and the review because it is the only row nobody has to act on.
  if (status.phase === WORKER_PHASE_RUNNING) {
    return `${PREFIX}indexing`;
  }

  // A detached worker's stderr goes to /dev/null, so without this a worker
  // that failed every night looks exactly like one with nothing to do.
  if (typeof status.lastError === "string" && status.lastError !== "") {
    return `${PREFIX}last run failed — run \`signpost doctor\``;
  }

  return "";
}

// ---------------------------------------------------------------------------
// Wrapping. `init` never takes a status line away from someone who already has
// one: it wraps theirs, and ours becomes a second row underneath.
// ---------------------------------------------------------------------------

/** The command to delegate to, or null when we are the only status line here. */
export function wrappedCommand(argv: readonly string[]): string | null {
  const flag = argv.indexOf(WRAP_FLAG);
  if (flag === -1) {
    return null;
  }
  const command = argv[flag + 1];
  return command === undefined || command === "" ? null : command;
}

/**
 * The wrapped command's output, given the same stdin we were given.
 *
 * Its exit code is ignored on purpose. A status line that prints something
 * useful and exits 1 is common enough — the platform's own git examples do it
 * — and dropping its output would be a regression the developer would blame
 * on us, correctly.
 */
export function delegate(command: string, stdin: string): string {
  try {
    const result = spawnSync(command, { shell: true, input: stdin, encoding: "utf8" });
    return typeof result.stdout === "string" ? result.stdout.replace(/\n+$/, "") : "";
  } catch {
    return "";
  }
}

/**
 * Ours goes on its own row rather than appended to theirs.
 *
 * Multi-line output is a documented feature of the bar, and a second row
 * cannot garble a line we did not write — appending to someone's carefully
 * spaced git segment can, and the platform's own notes warn that overlapping
 * escape sequences are where rendering goes wrong.
 */
export function compose(delegated: string, ours: string): string {
  return [delegated, ours].filter((part) => part !== "").join("\n");
}

// ---------------------------------------------------------------------------
// The command itself.
// ---------------------------------------------------------------------------

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return ""; // No stdin (a person running it by hand). Fall back to cwd.
  }
}

export function render(argv: readonly string[], stdin: string, nowMs: number): string {
  const wrapped = wrappedCommand(argv);
  const delegated = wrapped === null ? "" : delegate(wrapped, stdin);

  const repoRoot = findRepoRoot(sessionDir(stdin, process.cwd()));
  if (repoRoot === null) {
    return delegated; // Not a git repo. Nothing signposts does applies here.
  }

  const statusPath = path.join(
    homedir(),
    SIGNPOSTS_DIRNAME,
    hashRepoRoot(repoRoot),
    STATUSLINE_FILENAME,
  );
  return compose(delegated, statusLine(readStatus(statusPath), nowMs));
}

function main(): void {
  const line = render(process.argv.slice(2), readStdin(), Date.now());
  if (line !== "") {
    process.stdout.write(line + "\n");
  }
}

// Imported by its own tests, which must not render on import — same guard as
// the hook's, for the same reason.
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch {
    // An empty bar is a bad day. A stack trace in the bar is a bug report.
  }
}
