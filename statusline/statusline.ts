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

/** A run's progress, or a worker's phase, older than this belongs to nothing. */
const RUN_PROGRESS_STALE_MINUTES = 15;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
const REVIEW_EXPIRY_WARN_DAYS = 7;
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
  /** When the worker last wrote this snapshot — what ages `phase` out. */
  updatedAt?: string;
  threadsWaiting?: number;
  /**
   * The backlog: transcripts past the eligibility gate that no run has taken.
   * Written by the worker's census and re-stamped by `settle`. Absent from
   * this interface until the bar had a row for it — it transcribes what it
   * reads and nothing else.
   */
  eligibleSessions?: number;
  /** When the soonest parked review is dropped (19-value-to-a-user.md item 3). */
  reviewExpiresAt?: string;
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
function isFresh(stampedAt: unknown, nowMs: number): boolean {
  if (typeof stampedAt !== "string") {
    return false;
  }
  const stamped = Date.parse(stampedAt);
  return !Number.isNaN(stamped) && nowMs - stamped < RUN_PROGRESS_STALE_MS;
}

function liveProgress(status: WorkerStatus, nowMs: number): RunProgress | undefined {
  const progress = status.runProgress;
  return progress !== undefined && isFresh(progress.updatedAt, nowMs) ? progress : undefined;
}

/**
 * ` · expires in N days` inside REVIEW_EXPIRY_WARN_DAYS, and nothing outside
 * it. Transcribed from src/core/review/expiry.ts's `daysLeftToWarn`: a review
 * used to reach the developer only after it had been deleted.
 */
function expiryClause(status: WorkerStatus, nowMs: number): string {
  const expiresMs = typeof status.reviewExpiresAt === "string" ? Date.parse(status.reviewExpiresAt) : Number.NaN;
  if (Number.isNaN(expiresMs)) {
    return "";
  }
  const days = Math.max(0, Math.ceil((expiresMs - nowMs) / MS_PER_DAY));
  return days <= REVIEW_EXPIRY_WARN_DAYS ? ` · expires in ${plural(days, "day")}` : "";
}

/**
 * What signposts has to say right now, or "" for the common case of nothing.
 *
 * The order is by immediacy, and only one of these renders: a bar is one row
 * shared with whatever else the developer put there, so this earns at most a
 * clause of it. A parked review outranks a run in flight, which outranks the
 * worker reindexing, which outranks a failure nobody has been told about yet,
 * which outranks the backlog.
 *
 * The backlog row reverses an earlier decision, recorded here and in 07: the
 * bar said nothing when idle, because the hook already names the backlog once
 * per session start and a row repeating it every few seconds is noise. What
 * changed is that the notice is the only place it was ever said, so a
 * developer who closed the notice had nothing to look at — and the count is
 * now honest about being unjudged, which is what the earlier version could not
 * be (19-value-to-a-user.md).
 */
export function statusLine(status: WorkerStatus, nowMs: number): string {
  // Above the run's progress deliberately. A parked review is the one state
  // where nothing moves until the developer does something, and it is the
  // state that outlasts everything else here — a run halted on one re-stamps
  // no progress, so the progress row would age out and leave the bar blank at
  // exactly the moment it had something to ask for.
  const waiting = whole(status.threadsWaiting);
  if (waiting > 0) {
    return `${PREFIX}${plural(waiting, "change")} ${agrees(waiting, "need")} your review${expiryClause(status, nowMs)}`;
  }

  const progress = liveProgress(status, nowMs);
  if (progress !== undefined) {
    const done = whole(progress.sessionsDone);
    const total = Math.max(done, whole(progress.sessionsTotal));
    const found = whole(progress.found);
    // "found", not "signposts", and that is 07's wording rather than a
    // shortening of it: the count is one per candidate the session proposed a
    // change for, and a change is not always a new signpost — a retire removes
    // one and a reinforce adds provenance to one that was already there.
    return `${PREFIX}${done}/${total} sessions · ${String(found)} found`;
  }

  // The worker only ever reindexes (it cannot answer a model call), so this is
  // the one thing that is genuinely happening in the background. Below the
  // run and the review because it is the only row nobody has to act on.
  //
  // Aged out on the same window as the progress above, and for the same
  // reason: `phase` returns to idle in the worker's `finally`, which a SIGKILL
  // or a suspended laptop never reaches. Nothing repairs the file either — the
  // hook wakes a worker only when it has a reason to — so without this a
  // killed worker pins the bar to "indexing" for good.
  if (status.phase === WORKER_PHASE_RUNNING && isFresh(status.updatedAt, nowMs)) {
    return `${PREFIX}indexing`;
  }

  // A detached worker's stderr goes to /dev/null, so without this a worker
  // that failed every night looks exactly like one with nothing to do.
  if (typeof status.lastError === "string" && status.lastError !== "") {
    return `${PREFIX}last run failed — run \`signpost doctor\``;
  }

  // Last, because it asks for nothing: every row above is either happening now
  // or waiting on the developer. This is the backlog, and it used to be the
  // hook's message alone — said once per session start and gone.
  //
  // It says "not yet captured" and nothing else, because that is all anyone
  // knows. Which of these sessions holds something worth recording cannot be
  // decided without a model, and the free screens measured for it came out
  // barely better than chance (19-value-to-a-user.md, "can a free local screen
  // find the sessions worth a run?"). A count that claimed more than this
  // would be the daily-wrong number 07 warns gets a tool uninstalled.
  const eligible = whole(status.eligibleSessions);
  if (eligible > 0) {
    return `${PREFIX}${plural(eligible, "session")} not yet captured`;
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
