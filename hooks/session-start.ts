#!/usr/bin/env node
// The `SessionStart` hook (07-triggering-and-ux.md, "The blocking gotcha").
//
//     1. count eligible transcripts + resumable threads + stale/missing index
//     2. spawn the worker DETACHED
//     3. emit the notice, only if there is something to say
//     4. exit                                     // target HOOK_BUDGET_MS
//
// `SessionStart` hooks run synchronously and have no `async`/`asyncRewake`
// field, so every millisecond spent here is a millisecond the developer waits
// before their session starts. Two consequences shape this whole file:
//
// **It imports nothing from `src/`** — enforced by
// `eslint-rules/no-src-import-in-hooks-or-statusline.js`. Importing the
// application drags in the SQLite bindings and the LangGraph checkpointer and
// spends the budget on module loading alone, before a single decision is
// made. The constants below are therefore transcribed from 13-constants.md a
// second time rather than imported from `src/core/config/constants.ts`. That
// duplication is the price of the budget; it is the only copy in the repo,
// and 13-constants.md remains the authority for both.
//
// **Every check is a `stat` or a small read.** No database is opened, no
// transcript is hashed, no model is loaded, and nothing touches the network.
// The two facts that genuinely need the database — has this session already
// been processed, is a thread parked on a checkpoint — are read from the
// small state file the worker writes (`STATUSLINE_STATE`), because deriving
// them here would mean opening two SQLite files on every session start.
//
// So the conditions below are deliberately *over*-approximate: they answer
// "is it worth waking the worker", not "is there definitely work". The worker
// re-derives the truth with the real gates (`isEligible`, `decideCheckpoint`,
// `shouldReindex`) and exits cheaply when it disagrees. The one thing they
// must never do is under-approximate, which is why the session watermark is
// the last *finished* run rather than the mtime of the database: the database
// is written as each session completes, so a run interrupted after its first
// session would push the watermark past a transcript it never processed, and
// that transcript would never wake anything again.
//
// Any unexpected failure exits 0 in silence. A hook that throws is a hook
// that breaks `claude` for a bug in a background feature.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Constants — transcribed from 13-constants.md. See the header for why these
// are a second copy rather than an import.
// ---------------------------------------------------------------------------

/** Load-bearing: sessions are resumable, lower means extracting from unfinished work. */
const IDLE_HOURS = 24;
const MAX_AGE_DAYS = 90;
/** Older lock -> assume dead worker, take over. */
const LOCK_STALE_MINUTES = 60;

const SIGNPOSTS_DIRNAME = ".signposts";
const CLAUDE_CONFIG_DIRNAME = ".claude";
const TRANSCRIPT_DIRNAME = "projects";
const DB_FILENAME = "signposts.db";
const STATUSLINE_FILENAME = "status.json";
const LOCKFILE_FILENAME = "run.lock";

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

const IDLE_MS = IDLE_HOURS * MS_PER_HOUR;
const MAX_AGE_MS = MAX_AGE_DAYS * MS_PER_DAY;
const LOCK_STALE_MS = LOCK_STALE_MINUTES * MS_PER_MINUTE;

const TRANSCRIPT_EXTENSION = ".jsonl";
const REPO_HASH_LENGTH = 12;

/**
 * The detached process the hook wakes: `signpost worker`, through the ordinary
 * CLI entry point so it goes through the one composition root (R2).
 *
 * Overridable through `SIGNPOSTS_WORKER` so the timing harness and the
 * behaviour tests can point the hook at a stub — spawning the real
 * application, which opens a database and may load an ONNX pipeline, would
 * defeat the thing being measured.
 *
 * A missing entry point is not an error: the hook finds nothing to spawn and
 * exits silently, exactly as it does when there is no work.
 *
 * A worker that starts and then dies — a clone with no `node_modules`, a
 * killed terminal, anything — is `lockIsHeld`'s problem rather than this
 * function's: it checks the holder is still running, so a dead worker's lock
 * is free at the next session start instead of at the next hour.
 */
const WORKER_ENV_VAR = "SIGNPOSTS_WORKER";
const DEFAULT_WORKER = path.join("bin", "signpost.js");
/**
 * `--adopt-lock` tells the worker the run lock is already taken and is its to
 * release. The hook takes it before spawning, because the decision *not* to
 * spawn has to happen in the process deciding whether to spawn: three workers
 * started so two can find themselves redundant is three Node start-ups spent
 * to save nothing.
 */
const WORKER_ARGS = ["worker", "--adopt-lock"];


/** Claude Code exports the session's project directory to every hook. */
const PROJECT_DIR_ENV_VAR = "CLAUDE_PROJECT_DIR";
/** Claude Code moves its whole config directory, transcripts included, when this is set. */
const CONFIG_DIR_ENV_VAR = "CLAUDE_CONFIG_DIR";

const NOTICE_PREFIX = "🪧 signposts: ";

// ---------------------------------------------------------------------------
// Paths — the same derivations as src/core/config/paths.ts and
// src/core/transcript/project-dir.ts, which this file may not import.
// ---------------------------------------------------------------------------

/** Anything that is not part of a Claude Code project directory name. */
const NON_NAME = /[^a-zA-Z0-9]/g;

function projectDirName(repoRoot: string): string {
  return repoRoot.replace(/\/+$/, "").replace(NON_NAME, "-");
}

/** sha256(repoRoot), hex, first 12 characters — repoRoot as given, unnormalised. */
function hashRepoRoot(repoRoot: string): string {
  return createHash("sha256").update(repoRoot).digest("hex").slice(0, REPO_HASH_LENGTH);
}

export interface HookPaths {
  repoRoot: string;
  stateDir: string;
  dbPath: string;
  statuslineState: string;
  lockfile: string;
  knowledgeDir: string;
  transcriptRoot: string;
}

export function derivePaths(repoRoot: string, homeDir: string, claudeConfigDir?: string): HookPaths {
  const stateDir = path.join(homeDir, SIGNPOSTS_DIRNAME, hashRepoRoot(repoRoot));
  const configRoot =
    claudeConfigDir === undefined || claudeConfigDir === ""
      ? path.join(homeDir, CLAUDE_CONFIG_DIRNAME)
      : claudeConfigDir;

  return {
    repoRoot,
    stateDir,
    dbPath: path.join(stateDir, DB_FILENAME),
    statuslineState: path.join(stateDir, STATUSLINE_FILENAME),
    lockfile: path.join(stateDir, LOCKFILE_FILENAME),
    knowledgeDir: path.join(repoRoot, SIGNPOSTS_DIRNAME),
    transcriptRoot: path.join(configRoot, TRANSCRIPT_DIRNAME),
  };
}

/**
 * Nearest ancestor of `startDir` holding a `.git`, resolved through any
 * symlink, or null. A few stats and one realpath, no subprocess.
 *
 * The symlink resolution is load-bearing, not tidiness. STATE_DIR is
 * `sha256(repoRoot)[:12]` over the path *as given* (src/core/config/paths.ts
 * says so deliberately), and the worker this hook spawns derives its own
 * repoRoot from `process.cwd()` — which Node always reports as the physical
 * path. A checkout reached through a symlink would give the hook one hash and
 * the worker another: the hook would take a lock in one state directory while
 * the worker released one in another, and would read a status.json nothing
 * ever wrote. The two would look like they were cooperating and would share
 * nothing.
 *
 * Cheap enough to be unconditional: one realpath on a path already in the
 * kernel's cache, measured inside the budget by scripts/measure-hook.mjs.
 */
export function findRepoRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  for (;;) {
    if (exists(path.join(current, ".git"))) {
      try {
        return realpathSync(current);
      } catch {
        // Raced with a delete, or a permission we do not have. The unresolved
        // path is still better than giving up on the session entirely.
        return current;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

// ---------------------------------------------------------------------------
// Filesystem primitives. Every one of these answers "missing" rather than
// throwing, because a hook has no business distinguishing an absent state
// directory from an unreadable one: both mean "nothing to go on".
// ---------------------------------------------------------------------------

function mtimeMs(target: string): number | null {
  try {
    return statSync(target).mtimeMs;
  } catch {
    return null;
  }
}

function exists(target: string): boolean {
  return mtimeMs(target) !== null;
}

// ---------------------------------------------------------------------------
// The state file the worker writes (STATUSLINE_STATE). Everything on it is
// optional and independently defaulted: the statusLine owns the rest of this
// file's shape, and a field the worker has not written yet must not stop the
// hook reading the ones it has.
// ---------------------------------------------------------------------------

export interface WorkerState {
  /** ISO timestamp of the last run that *finished*. The session watermark — see the header. */
  lastRunFinishedAt?: string;
  /**
   * Threads parked on `human_review`.
   *
   * Named for what is true of them rather than for the wake condition
   * 07-triggering-and-ux.md calls "resumable threads": the worker cannot
   * resume one. Answering a halt means answering a model call or a review,
   * and both need the Claude Code session the worker does not have. The count
   * earns its place by driving the notice — the developer is the one who can
   * act on it.
   */
  threadsWaiting?: number;
  /**
   * Session id to the last activity it was judged at — the transcript's mtime
   * then. Written by the run commands for every session they finish or skip,
   * so a run that judged two of five stops the hook counting those two before
   * the watermark can move (19-value-to-a-user.md item 2).
   */
  judgedSessions?: Record<string, string>;
}

export function readWorkerState(statuslineState: string): WorkerState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(statuslineState, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as WorkerState) : {};
  } catch {
    return {};
  }
}

/** Epoch ms of `lastRunFinishedAt`, or 0 when absent or unparseable — 0 means "consider everything". */
export function watermarkMs(state: WorkerState): number {
  if (typeof state.lastRunFinishedAt !== "string") {
    return 0;
  }
  const parsed = Date.parse(state.lastRunFinishedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * `judgedSessions` as epoch ms, dropping any entry that does not parse — a
 * malformed entry must make the hook count that transcript, never hide it.
 */
export function judgedSessions(state: WorkerState): Record<string, number> {
  const judged: Record<string, number> = {};
  const entries = state.judgedSessions;
  if (typeof entries !== "object" || entries === null) {
    return judged;
  }
  for (const [sessionId, at] of Object.entries(entries)) {
    const ms = typeof at === "string" ? Date.parse(at) : Number.NaN;
    if (!Number.isNaN(ms)) {
      judged[sessionId] = ms;
    }
  }
  return judged;
}

// ---------------------------------------------------------------------------
// The three wake conditions.
// ---------------------------------------------------------------------------

/**
 * Pure half of condition 1, so the gate can be tested without a transcript
 * directory. The eligibility gate proper (src/core/eligibility) also checks
 * the content hash against what has been processed and whether the session is
 * a sidechain; both need the database or the file's bytes, so the watermark
 * stands in for them here.
 */
export function looksEligible(
  file: { lastActivityMs: number; startedMs: number },
  nowMs: number,
  watermark: number,
): boolean {
  const idle = nowMs - file.lastActivityMs >= IDLE_MS;
  const notTooOld = nowMs - file.startedMs <= MAX_AGE_MS;
  const sinceLastRun = file.lastActivityMs > watermark;
  return idle && notTooOld && sinceLastRun;
}

/**
 * Whether a run has judged this exact transcript: same session id, and an
 * mtime within a millisecond of the one it was judged at. The recorded value
 * is a `Date` built from the same stat, which carries whole milliseconds where
 * `mtimeMs` carries a fraction — hence a window rather than equality. A
 * transcript touched since has moved further than that, and counts again.
 */
export function alreadyJudged(judgedAtMs: number | undefined, mtimeMs: number): boolean {
  return judgedAtMs !== undefined && Math.abs(mtimeMs - judgedAtMs) < 1;
}

/** How many of this repo's transcripts are worth waking the worker for. */
export function countEligibleSessions(
  paths: HookPaths,
  nowMs: number,
  watermark: number,
  judged: Record<string, number> = {},
): number {
  const projectDir = path.join(paths.transcriptRoot, projectDirName(paths.repoRoot));

  let entries: string[];
  try {
    entries = readdirSync(projectDir);
  } catch {
    // No transcripts for this repo yet — not an error, just nothing to do.
    return 0;
  }

  let count = 0;
  for (const entry of entries) {
    if (!entry.endsWith(TRANSCRIPT_EXTENSION)) {
      continue;
    }
    let stats;
    try {
      stats = statSync(path.join(projectDir, entry));
    } catch {
      continue;
    }
    if (alreadyJudged(judged[entry.slice(0, -TRANSCRIPT_EXTENSION.length)], stats.mtimeMs)) {
      continue;
    }
    if (looksEligible({ lastActivityMs: stats.mtimeMs, startedMs: stats.birthtimeMs }, nowMs, watermark)) {
      count += 1;
    }
  }
  return count;
}

/** Condition 2. Only the worker knows this; the hook reads what it last wrote. */
export function countThreadsWaiting(state: WorkerState): number {
  const threads = state.threadsWaiting;
  return typeof threads === "number" && Number.isFinite(threads) && threads > 0 ? Math.floor(threads) : 0;
}

/**
 * Condition 3, local-only and free of credentials (05-retrieval.md, "The
 * `SessionStart` hook builds it"): a cold clone full of signposts and no
 * database gets its index built without ever reaching the API.
 *
 * The real trigger is a corpus-hash mismatch, which means reading and hashing
 * every `.signposts/**\/*.md` against a row in the database. The mtime
 * comparison here is the cheap shadow of it: a `git pull` that brings a
 * teammate's signposts in rewrites those files, and a checkout sets their
 * mtime to now. Over-approximate on purpose — `shouldReindex` is authoritative
 * and the worker exits without work when it says no.
 */
export function indexIsStale(paths: HookPaths): boolean {
  if (!exists(paths.knowledgeDir)) {
    return false; // Nothing to index; `init` has not run here.
  }
  const indexedAt = mtimeMs(paths.dbPath);
  if (indexedAt === null) {
    return true; // Signposts on disk, no index at all — the cold-clone case.
  }
  return newestCorpusMtime(paths.knowledgeDir, indexedAt) > indexedAt;
}

/**
 * Newest mtime under `.signposts/`, abandoning the walk as soon as one entry
 * beats `threshold` — the answer is a boolean to the caller, and the common
 * case is a corpus that has not moved.
 */
function newestCorpusMtime(knowledgeDir: string, threshold: number): number {
  let newest = 0;
  let entries;
  try {
    entries = readdirSync(knowledgeDir, { withFileTypes: true, recursive: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      continue;
    }
    const stamp = mtimeMs(path.join(entry.parentPath, entry.name));
    if (stamp !== null && stamp > newest) {
      newest = stamp;
      if (newest > threshold) {
        return newest;
      }
    }
  }
  return newest;
}

// ---------------------------------------------------------------------------
// The lockfile. "Guard with a lockfile so five terminals don't start five
// workers" (07). `wx` is the whole mechanism: an atomic create is the only
// thing that stays correct when three sessions start at the same instant, so
// the loser of the race is the process whose `open` threw, not one that
// checked and then wrote.
// ---------------------------------------------------------------------------

/**
 * The pid in a lockfile, or null when there is none to read. Transcribed from
 * `lockHolder` in src/io/worker/lock.ts, which this file may not import.
 */
function lockPid(lockfile: string): number | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockfile, "utf8"));
    const pid = (parsed as { pid?: unknown }).pid;
    return typeof pid === "number" ? pid : null;
  } catch {
    return null;
  }
}

/**
 * `kill(pid, 0)` sends no signal, it asks whether it could. ESRCH is no such
 * process; EPERM is one we do not own, answered "alive" as the conservative
 * direction. Transcribed from src/io/worker/lock.ts for the same reason.
 */
function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * True when a worker holds the lock.
 *
 * A lock is a dead worker's when it is older than LOCK_STALE_MINUTES *or* when
 * the process that wrote it is gone, and either way it is removed. The age
 * alone was the whole test, so a worker that died without releasing — killed
 * with its terminal, or dead at import on an install with no build
 * (18-end-to-end-gaps.md item 10) — held the lock for the full hour, and every
 * session start in that window found it, exited, and said nothing. The pid has
 * been in the file since the first version; nothing but `doctor` ever read it.
 */
export function lockIsHeld(lockfile: string, nowMs: number): boolean {
  const heldSince = mtimeMs(lockfile);
  if (heldSince === null) {
    return false;
  }
  const pid = lockPid(lockfile);
  if (nowMs - heldSince < LOCK_STALE_MS && (pid === null || processIsRunning(pid))) {
    return true;
  }
  try {
    unlinkSync(lockfile);
  } catch {
    // Another process took it over first; either way it is no longer ours to hold.
  }
  return false;
}

/** Atomically claims the lock. False means another session won the race — the caller exits silently. */
export function acquireLock(paths: HookPaths, pid: number, nowMs: number): boolean {
  try {
    mkdirSync(paths.stateDir, { recursive: true });
    const handle = openSync(paths.lockfile, "wx");
    try {
      writeSync(handle, JSON.stringify({ pid, startedAt: new Date(nowMs).toISOString() }));
    } finally {
      closeSync(handle);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Rewrites the lock we already hold to name the worker we just spawned.
 *
 * The lock has to be taken before the spawn (see WORKER_ARGS), so it is first
 * written with *this* process's pid — and this process exits a millisecond
 * later, while the worker is still a second away from its own
 * `takeLock({adopt:true})`: the whole `production-app` import sits between the
 * two. For that second the lockfile named a dead process, and the pid check
 * that `lockIsHeld` and `heldByALiveWorker` now do read it as a dead worker's
 * lock — so a second session start in that window unlinked it and spawned a
 * second worker onto the same rows. The freshness check used to cover this;
 * the pid check is what exposed it. Stamping the child's pid before we exit
 * closes the window: the file names a live process from the moment it stops
 * naming us.
 */
function stampLockHolder(paths: HookPaths, pid: number, nowMs: number): void {
  try {
    const handle = openSync(paths.lockfile, "w");
    try {
      writeSync(handle, JSON.stringify({ pid, startedAt: new Date(nowMs).toISOString() }));
    } finally {
      closeSync(handle);
    }
  } catch {
    // The worker is already running and adopts the lock itself; a lock still
    // naming us is the pre-existing window, not a reason to kill the run.
  }
}

function releaseLock(lockfile: string): void {
  try {
    unlinkSync(lockfile);
  } catch {
    // Already gone. Nothing to undo.
  }
}

// ---------------------------------------------------------------------------
// The notice. "Gate every notice on there actually being something to say"
// (07) — this is only ever called after a worker has actually been spawned.
//
// It goes out as `systemMessage` rather than as bare stdout: `SessionStart`
// stdout is injected into Claude's context, and an agent that reads "starting
// to build repo memory" starts discussing the tool instead of doing the work.
// ---------------------------------------------------------------------------

export interface WakeReasons {
  sessions: number;
  threads: number;
  staleIndex: boolean;
}

export function anyWork(reasons: WakeReasons): boolean {
  return reasons.sessions > 0 || reasons.threads > 0 || reasons.staleIndex;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The verb has to agree with the count too: "1 change needs", "2 changes need". */
function agrees(count: number, verb: string): string {
  return count === 1 ? `${verb}s` : verb;
}

/**
 * The notice, split by who does the work and by what they would have to type.
 *
 * Only the index is rebuilt in the background. Sessions and parked threads
 * both need a model call answered, and those are answered by the Claude Code
 * session (src/graph/host-model.ts) — so the worker counts them and the
 * developer acts on them. Saying "distilling 3 sessions in the background"
 * when nothing is distilling them is the kind of claim that gets a tool
 * uninstalled the week someone checks.
 *
 * The two waiting cases are separate clauses because they are separate
 * commands: a backlog of transcripts is `signpost run`, a parked review is
 * `signpost review`, and one message naming both actions is more useful than
 * two notices or a vague one. The wording follows 07-triggering-and-ux.md's
 * worked example, "2 changes need your review — run `signpost review`".
 */
/**
 * What Claude is told, as distinct from what the developer is shown.
 *
 * `systemMessage` reaches the developer and nothing else — a session started
 * behind one answers "no codeword" when asked what it can see, which is why
 * the notice alone left the run waiting on somebody remembering a command.
 * `additionalContext` is the field that reaches the model, so this is what
 * turns the notice into an offer Claude can make.
 *
 * It stays an offer. A run spends this session's tokens on work the developer
 * did not sit down to do (07-triggering-and-ux.md: "starting it is theirs to
 * decide"), so the instruction is to ask, and to drop it on a no.
 *
 * Only the two developer-facing conditions produce it. A stale index is the
 * worker's job and needs nobody's permission, and an offer to do work that is
 * already happening is noise in a context window the developer is paying for.
 */
export function contextFor(reasons: WakeReasons): string | null {
  const waiting: string[] = [];
  if (reasons.sessions > 0) {
    waiting.push(
      `${plural(reasons.sessions, "session")} of this repo's history ready to distil into team knowledge (\`signpost run\`)`,
    );
  }
  if (reasons.threads > 0) {
    waiting.push(
      `${plural(reasons.threads, "proposed change")} parked for the developer's review (\`signpost review\`)`,
    );
  }
  if (waiting.length === 0) {
    return null;
  }

  return (
    `signposts has ${waiting.join(", and ")}. ` +
    "Offer this to the developer before their next task and wait for an answer — a run spends this " +
    "session's tokens, so it is theirs to start. On a yes, drive it with the signposts skill. On a no, " +
    "drop it and do not raise it again this session."
  );
}

/** `systemMessage` for the developer, `additionalContext` for Claude — see `contextFor`. */
export function hookOutput(reasons: WakeReasons): Record<string, unknown> {
  const context = contextFor(reasons);
  const output: Record<string, unknown> = { systemMessage: noticeFor(reasons) };
  if (context !== null) {
    output["hookSpecificOutput"] = {
      hookEventName: "SessionStart",
      additionalContext: context,
    };
  }
  return output;
}

export function noticeFor(reasons: WakeReasons): string {
  const parts: string[] = [];
  if (reasons.staleIndex) {
    parts.push("rebuilding the search index in the background");
  }
  if (reasons.sessions > 0) {
    parts.push(`${plural(reasons.sessions, "session")} ready — run \`signpost run\``);
  }
  if (reasons.threads > 0) {
    parts.push(
      `${plural(reasons.threads, "change")} ${agrees(reasons.threads, "need")} your review — run \`signpost review\``,
    );
  }
  return NOTICE_PREFIX + parts.join("; ");
}

// ---------------------------------------------------------------------------
// Spawning. `detached` + `stdio: "ignore"` + `unref()` is what lets the worker
// outlive the hook: without the detach it dies with the session's process
// group, and without ignoring stdio it holds the hook's pipes open and the
// hook never exits.
// ---------------------------------------------------------------------------

/** The package root, from this file's own location: <root>/hooks/session-start.{ts,js}. */
function packageRoot(): string {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

/** The worker's entry point, or null when it is not installed — see WORKER_ENV_VAR. */
export function resolveWorker(env: NodeJS.ProcessEnv, root: string): string | null {
  const override = env[WORKER_ENV_VAR];
  const entry = override === undefined || override === "" ? path.join(root, DEFAULT_WORKER) : override;
  return exists(entry) ? entry : null;
}

/** The spawned worker's pid, or null when the platform did not give us one. */
function spawnWorker(worker: string, repoRoot: string): number | null {
  const child = spawn(process.execPath, [worker, ...WORKER_ARGS], {
    cwd: repoRoot,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid ?? null;
}

// ---------------------------------------------------------------------------
// The hook itself.
// ---------------------------------------------------------------------------

function main(): void {
  const startDir = process.env[PROJECT_DIR_ENV_VAR] ?? process.cwd();
  const repoRoot = findRepoRoot(startDir);
  if (repoRoot === null) {
    return; // Not a git repo. Nothing signposts does applies here.
  }

  const paths = derivePaths(repoRoot, homedir(), process.env[CONFIG_DIR_ENV_VAR]);

  // Cheapest exit first: a repo where `init` never ran has no `.signposts/`,
  // and the hook must not create state — let alone a database — for a repo
  // that has not consented (R3).
  if (!exists(paths.knowledgeDir)) {
    return;
  }

  const nowMs = Date.now();
  if (lockIsHeld(paths.lockfile, nowMs)) {
    return; // A worker is already draining. Two would race on the same rows.
  }

  const state = readWorkerState(paths.statuslineState);
  const reasons: WakeReasons = {
    sessions: countEligibleSessions(paths, nowMs, watermarkMs(state), judgedSessions(state)),
    threads: countThreadsWaiting(state),
    staleIndex: indexIsStale(paths),
  };
  if (!anyWork(reasons)) {
    return;
  }

  const worker = resolveWorker(process.env, packageRoot());
  if (worker === null) {
    return; // Nothing to spawn, so nothing to announce.
  }

  // The lock is taken only once there is work and a worker to do it, so the
  // common no-op path never writes to disk at all.
  if (!acquireLock(paths, process.pid, nowMs)) {
    return; // Another session start won the race.
  }

  let workerPid: number | null;
  try {
    workerPid = spawnWorker(worker, repoRoot);
  } catch {
    releaseLock(paths.lockfile);
    return;
  }
  if (workerPid !== null) {
    stampLockHolder(paths, workerPid, nowMs);
  }

  process.stdout.write(JSON.stringify(hookOutput(reasons)) + "\n");
}

/**
 * `bin/signpost.js` is imported by nothing; this file is imported by its own
 * tests, which must not spawn a worker on import. Node sets `argv[1]` to the
 * script it was told to run, so comparing it to this module's own path is
 * what distinguishes "run as the hook" from "imported for its functions".
 */
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch {
    // A hook that throws breaks `claude` for a bug in a background feature.
  }
}
