// Reading and writing `<STATE_DIR>/status.json`. The shape is
// src/core/worker/status.ts; this is the filesystem half.
//
// Both directions swallow their errors. The status file is a progress report,
// and a worker that failed to write one has still done its work — throwing
// here would turn a cosmetic failure into a run that reindexed nothing. The
// hook takes the same view from the other side.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { JSON_INDENT } from "../../core/config/constants.ts";
import {
  runFinishedStatus,
  runProgressStatus,
  type WorkerStatus,
} from "../../core/worker/status.ts";

/** Writes the snapshot, creating the state directory if this is the repo's first run. */
export function writeStatus(statusPath: string, status: WorkerStatus): void {
  try {
    mkdirSync(path.dirname(statusPath), { recursive: true });
    writeFileSync(statusPath, JSON.stringify(status, null, JSON_INDENT) + "\n");
  } catch {
    // See the module comment: never fail a run over its own progress report.
  }
}

/** The last snapshot, or undefined when there is none this build can read. */
export function readStatus(statusPath: string): WorkerStatus | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(statusPath, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as WorkerStatus) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Moves the session watermark, leaving the worker's census where it is.
 *
 * Read-modify-write rather than a plain write: the run commands own
 * `lastRunFinishedAt` and the worker owns the counts, and the two processes
 * write the same file, so a wholesale write from either side erases the
 * other's half.
 */
export function recordRunFinished(statusPath: string, finishedThrough: Date): void {
  writeStatus(statusPath, runFinishedStatus(readStatus(statusPath), finishedThrough));
}

/**
 * Moves the run's progress, leaving the worker's census where it is — the same
 * read-modify-write as `recordRunFinished`, and for the same reason: two
 * processes share this file and neither owns all of it.
 */
export function recordRunProgress(
  statusPath: string,
  progress: { now: Date; remaining: number; sessionFinished: boolean; found: number },
): void {
  writeStatus(statusPath, runProgressStatus(readStatus(statusPath), progress));
}
