// The status file's shape, and the pure half of writing it.
//
// `<STATE_DIR>/status.json` (13-constants.md's STATUSLINE_STATE) is the
// worker's only channel to anything outside its own process. Three readers,
// which is why it is a file and not a return value:
//
//   - the statusLine, for live progress while a run is in flight (07)
//   - the SessionStart hook, which cannot open a database inside
//     HOOK_BUDGET_MS and so reads the counts the worker already paid for
//   - a person, when the worker failed in a detached process whose stderr
//     went to /dev/null
//
// Everything here is optional on read. The hook ships compiled and separately
// (hooks/session-start.ts), so a worker and a hook from different versions
// will meet, and a field one of them has not learned about yet must not stop
// the other reading the fields it knows.
//
// PURE: counts and a clock reading in, a snapshot out. The write itself is
// src/io/worker/status-file.ts.

import { RUN_PROGRESS_STALE_MINUTES } from "../config/constants.ts";

const MS_PER_MINUTE = 60_000;
const RUN_PROGRESS_STALE_MS = RUN_PROGRESS_STALE_MINUTES * MS_PER_MINUTE;

/**
 * How far a run has got, for the statusLine (07-triggering-and-ux.md, "Live
 * progress"). Written by whatever drains a session — `settle` in
 * src/cli/with-run.ts — never by the worker, which drains none.
 *
 * A run is a sequence of processes, one per halt, so the count cannot live in
 * memory: each invocation reads what the last one left and adds its own
 * session to it. `total` is derived rather than stored, because a run does not
 * know its own length either — sessions become ineligible as they finish, so
 * what is left plus what is done is the only honest denominator.
 */
export interface RunProgress {
  /** Sessions this run has finished. */
  sessionsDone: number;
  /** `sessionsDone` plus what is still eligible, as of `updatedAt`. */
  sessionsTotal: number;
  /** Signposts the finished sessions proposed. Mid-session work is not counted until it lands. */
  found: number;
  /** When an invocation last moved this. See RUN_PROGRESS_STALE_MINUTES. */
  updatedAt: string;
}

/**
 * Whether progress is recent enough to belong to a run that is still
 * happening. A terminal closed between two halts leaves progress behind with
 * nothing to finish it, and a statusLine that renders "2/3 sessions" for the
 * rest of the week is worse than one that renders nothing.
 */
export function progressIsLive(progress: RunProgress | undefined, now: Date): boolean {
  if (progress === undefined) {
    return false;
  }
  const stamped = Date.parse(progress.updatedAt);
  return !Number.isNaN(stamped) && now.getTime() - stamped < RUN_PROGRESS_STALE_MS;
}

/** What the worker is doing, for the statusLine to render. */
export const WORKER_PHASES = {
  running: "running",
  idle: "idle",
} as const;

export type WorkerPhase = (typeof WORKER_PHASES)[keyof typeof WORKER_PHASES];

export interface WorkerStatus {
  phase: WorkerPhase;
  /** When this snapshot was written. */
  updatedAt: string;
  /**
   * Transcripts past the eligibility gate and not yet processed.
   *
   * The worker cannot process them — extraction needs model calls, and those
   * are answered by the Claude Code session that started the run
   * (src/graph/host-model.ts), which a detached process does not have. So
   * this is a census, and the number exists to tell the developer there is
   * something to run, not to report work done.
   */
  eligibleSessions: number;
  /**
   * Threads parked on `human_review`. Only the developer can answer these.
   *
   * Written by the worker's census and by `settle` (src/cli/with-run.ts), both
   * from `pendingReviews` over the checkpoint database. `settle` writes it
   * because the worker only runs when a session starts: without that, a review
   * a run parked five minutes ago is invisible until the next `claude`.
   */
  threadsWaiting: number;
  /** Set when the worker rebuilt the search index this run. Absent when it was already current. */
  lastIndexedAt?: string;
  /**
   * The last thing that went wrong, for `doctor` and the statusLine.
   *
   * A detached worker's stderr goes nowhere: the hook spawns it with
   * `stdio: "ignore"` because holding the hook's pipes open would stop the
   * hook exiting. Without this field a worker that failed every night would
   * look exactly like one that had nothing to do.
   */
  lastError?: string;
  /**
   * The session watermark: activity at or before this has been judged, so the
   * hook stops waking for it (hooks/session-start.ts, `watermarkMs`).
   *
   * It belongs to whatever actually drains a session — `settle` in
   * src/cli/with-run.ts stamps it, and only once nothing eligible is left. The
   * worker writes none of it and carries whatever it found forward, because
   * the worker and the run commands share this file and neither may erase the
   * other's half of it.
   */
  lastRunFinishedAt?: string;
  /**
   * The run in flight, absent between runs. Owned by `settle`, like the
   * watermark: the worker carries it forward untouched.
   */
  runProgress?: RunProgress;
}

export interface SnapshotInput {
  now: Date;
  eligibleSessions: number;
  threadsWaiting: number;
  indexedAt?: Date | undefined;
  error?: string | undefined;
  /** Carried forward from the previous snapshot, never minted here. */
  lastRunFinishedAt?: string | undefined;
  /** Likewise: a run may be halted on a review while the worker reindexes around it. */
  runProgress?: RunProgress | undefined;
}

/**
 * A count as the file should carry it: whole, not negative, never NaN.
 *
 * Written as a clamp rather than as `value > 0 ? floor(value) : 0`, because
 * that form has a boundary at zero that does not exist — both sides of it
 * produce 0 — and an equivalent mutant sitting on a comparison is a mutation
 * score nobody can act on.
 */
function count(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

/** The snapshot written while the worker is still working — counts not yet taken. */
export function runningStatus(
  now: Date,
  lastRunFinishedAt?: string,
  runProgress?: RunProgress,
): WorkerStatus {
  return {
    phase: WORKER_PHASES.running,
    updatedAt: now.toISOString(),
    eligibleSessions: 0,
    threadsWaiting: 0,
    ...(lastRunFinishedAt === undefined ? {} : { lastRunFinishedAt }),
    ...(runProgress === undefined ? {} : { runProgress }),
  };
}

/**
 * The snapshot written as the worker exits.
 *
 * Never mints `lastRunFinishedAt`, the watermark the hook uses to stop waking
 * for a session that has already been judged; it only passes back whatever the
 * caller read off the previous snapshot. Minting it here would be a lie with a
 * long tail: the worker counted those sessions and processed none of them, and
 * a watermark past their last activity would silence the hook about them
 * permanently. It belongs to whatever actually drains a session — `settle` in
 * src/cli/with-run.ts.
 */
export function finishedStatus(input: SnapshotInput): WorkerStatus {
  return {
    phase: WORKER_PHASES.idle,
    updatedAt: input.now.toISOString(),
    eligibleSessions: count(input.eligibleSessions),
    threadsWaiting: count(input.threadsWaiting),
    ...(input.indexedAt === undefined ? {} : { lastIndexedAt: input.indexedAt.toISOString() }),
    ...(input.error === undefined ? {} : { lastError: input.error }),
    ...(input.lastRunFinishedAt === undefined
      ? {}
      : { lastRunFinishedAt: input.lastRunFinishedAt }),
    ...(input.runProgress === undefined ? {} : { runProgress: input.runProgress }),
  };
}

/**
 * The previous snapshot with the watermark moved to `finishedThrough`.
 *
 * The value is the finished session's own last activity, not the wall clock.
 * The hook compares it against transcript mtimes, and a wall-clock stamp
 * silences every transcript that fell quiet just before it — including the
 * session the developer was sitting in while the run went through.
 *
 * `updatedAt` stays where it was, because it dates the worker's census and
 * this path counts nothing. A file that has no census yet is dated by the
 * watermark itself, which is the only reading of a clock this path has.
 */
export function runFinishedStatus(
  previous: WorkerStatus | undefined,
  finishedThrough: Date,
): WorkerStatus {
  const base: WorkerStatus = previous ?? {
    phase: WORKER_PHASES.idle,
    updatedAt: finishedThrough.toISOString(),
    eligibleSessions: 0,
    threadsWaiting: 0,
  };
  // The watermark moves only when nothing eligible is left, which is also the
  // moment the run stops being in flight — so the progress goes with it rather
  // than sitting at "3/3" until it ages out.
  const { runProgress: _finished, ...withoutProgress } = base;
  return { ...withoutProgress, lastRunFinishedAt: finishedThrough.toISOString() };
}

/**
 * The previous snapshot with the run's progress advanced by one settled
 * session.
 *
 * `sessionsDone` counts what has finished, so a session that halted on a
 * review moves nothing but the clock: the halt is what keeps the line alive
 * while the developer answers it. `remaining` is what the caller still finds
 * eligible, which is the only denominator either side of this can know.
 *
 * Progress that has aged out is replaced rather than continued
 * (RUN_PROGRESS_STALE_MINUTES) — a run abandoned last week must not have its
 * count adopted by this one. `freshRun` says the same thing precisely: it is
 * `--first`, the flag that declares a new run, and a run abandoned five
 * minutes ago is inside the window while still being somebody else's count.
 */
export function runProgressStatus(
  previous: WorkerStatus | undefined,
  input: {
    now: Date;
    remaining: number;
    sessionFinished: boolean;
    found: number;
    threadsWaiting: number;
    /** `--first`: this session starts a run, so it inherits no progress. */
    freshRun: boolean;
  },
): WorkerStatus {
  const base: WorkerStatus = previous ?? {
    phase: WORKER_PHASES.idle,
    updatedAt: input.now.toISOString(),
    eligibleSessions: 0,
    threadsWaiting: 0,
  };
  const carried =
    !input.freshRun && progressIsLive(base.runProgress, input.now) ? base.runProgress : undefined;
  const sessionsDone = (carried?.sessionsDone ?? 0) + (input.sessionFinished ? 1 : 0);
  return {
    ...base,
    // Re-stamped, because this write is a snapshot: the two counts below are
    // taken now, and leaving `updatedAt` at whatever the worker last wrote
    // would date fresh numbers by a census that happened minutes ago.
    updatedAt: input.now.toISOString(),
    // The census, retaken. It used to be the worker's alone, which left the
    // one number the developer needs — a review parked on them — written only
    // when a SessionStart happened to wake a worker. A run has the same
    // database open and knows the answer the moment it halts, so it says so.
    // Both counts come from the same source the worker's census does, so this
    // replaces that count with a fresher one rather than competing with it.
    eligibleSessions: count(input.remaining),
    threadsWaiting: count(input.threadsWaiting),
    runProgress: {
      sessionsDone,
      sessionsTotal: sessionsDone + count(input.remaining),
      // Counted at finish only. A session that halts, is resumed and halts
      // again reports its proposals each time, and adding them on every settle
      // would count the same signpost once per halt.
      found: (carried?.found ?? 0) + (input.sessionFinished ? count(input.found) : 0),
      updatedAt: input.now.toISOString(),
    },
  };
}
