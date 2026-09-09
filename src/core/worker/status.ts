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
  /** Threads parked on `human_review`. Only the developer can answer these. */
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
}

export interface SnapshotInput {
  now: Date;
  eligibleSessions: number;
  threadsWaiting: number;
  indexedAt?: Date | undefined;
  error?: string | undefined;
  /** Carried forward from the previous snapshot, never minted here. */
  lastRunFinishedAt?: string | undefined;
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
export function runningStatus(now: Date, lastRunFinishedAt?: string): WorkerStatus {
  return {
    phase: WORKER_PHASES.running,
    updatedAt: now.toISOString(),
    eligibleSessions: 0,
    threadsWaiting: 0,
    ...(lastRunFinishedAt === undefined ? {} : { lastRunFinishedAt }),
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
  return { ...base, lastRunFinishedAt: finishedThrough.toISOString() };
}
