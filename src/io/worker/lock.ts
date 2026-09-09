// The run lockfile (13-constants.md's LOCKFILE), from the worker's side.
//
// 07-triggering-and-ux.md: "Guard with a lockfile so five terminals don't
// start five workers." The guard has two halves, and this is the second one.
//
// The SessionStart hook takes the lock *before* it spawns, because the check
// has to happen in the process that decides whether to spawn at all —
// spawning three workers so that two can discover they are redundant costs
// three Node start-ups to save nothing. So when the hook is what started us,
// the lock already exists and is ours: we adopt it, stamping our own pid over
// the hook's, and release it on the way out. The hook says so with
// `--adopt-lock`, rather than us guessing from a pid that may or may not
// still be alive by the time we look.
//
// Run by hand (`signpost worker`), there is no hook and no lock, so we take
// one the same way the hook does: `wx`, an atomic create, which is the only
// check that stays correct when two processes race.

import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { LOCK_STALE_MINUTES } from "../../core/config/constants.ts";

const MS_PER_MINUTE = 60_000;
const LOCK_STALE_MS = LOCK_STALE_MINUTES * MS_PER_MINUTE;

export interface LockInput {
  lockfile: string;
  stateDir: string;
  pid: number;
  now: Date;
  /** The hook already holds it for us — adopt rather than compete for it. */
  adopt: boolean;
}

export type LockResult =
  | { held: true; release(): void }
  /** Another worker has it and is not stale. Nothing to do; exit quietly. */
  | { held: false };

function write(lockfile: string, pid: number, now: Date, exclusive: boolean): void {
  const handle = openSync(lockfile, exclusive ? "wx" : "w");
  try {
    writeSync(handle, JSON.stringify({ pid, startedAt: now.toISOString() }));
  } finally {
    closeSync(handle);
  }
}

/** True when a lock exists and is younger than LOCK_STALE_MINUTES — a live worker's. */
function heldByALiveWorker(lockfile: string, now: Date): boolean {
  try {
    return now.getTime() - statSync(lockfile).mtimeMs < LOCK_STALE_MS;
  } catch {
    return false; // No lock at all.
  }
}

export function takeLock(input: LockInput): LockResult {
  mkdirSync(input.stateDir, { recursive: true });

  const release = (): void => {
    try {
      unlinkSync(input.lockfile);
    } catch {
      // Already gone — a stale-lock takeover, or a tidier that beat us here.
      // Either way there is nothing left to release.
    }
  };

  if (input.adopt) {
    write(input.lockfile, input.pid, input.now, false);
    return { held: true, release };
  }

  // A stale lock is a dead worker's: the process that wrote it was killed with
  // the terminal, and nothing else will ever remove it.
  if (heldByALiveWorker(input.lockfile, input.now)) {
    return { held: false };
  }
  try {
    unlinkSync(input.lockfile);
  } catch {
    // Nothing there. The create below is the real check either way.
  }

  try {
    write(input.lockfile, input.pid, input.now, true);
    return { held: true, release };
  } catch {
    return { held: false }; // Lost the race between the check and the create.
  }
}

/** The pid recorded in a lockfile, for `doctor`. Undefined when unreadable. */
export function lockHolder(lockfile: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockfile, "utf8"));
    const pid = (parsed as { pid?: unknown }).pid;
    return typeof pid === "number" ? pid : undefined;
  } catch {
    return undefined;
  }
}
