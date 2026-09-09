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
import type { WorkerStatus } from "../../core/worker/status.ts";

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
