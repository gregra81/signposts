// `signpost worker` — the detached background process the SessionStart hook
// spawns (07-triggering-and-ux.md, "The blocking gotcha").
//
// **What it can do, and the hard limit on that.** The hook wakes on three
// conditions: eligible sessions, threads waiting, and a stale or missing
// index. Only the third is work this process can actually perform.
//
// Extraction needs `extract`, `critic`, `classify` and `resolve_conflict`, and
// every one of those is a model call. signposts holds no credential and calls
// no API: `hostModel` implements the ModelProvider port with `interrupt()`, so
// a model call halts the run and is answered by the Claude Code session that
// started it (src/graph/host-model.ts). A detached worker has no session
// behind it, so a run it started would halt on the first `extract` and never
// come back. It does not start one.
//
// Reindexing is the opposite case, and 05-retrieval.md says why it is the
// third wake condition: it is local, free, and needs no credential, so a
// developer who cloned a repo full of signposts and never authenticated still
// gets a working index and a working MCP server out of a background process.
//
// So the worker does one job and takes one census:
//
//   1. rebuild the index if the corpus moved  — real work, and the whole
//      reason the hook wakes anything at all
//   2. count what is waiting                  — into status.json, so the next
//      SessionStart can tell the developer, and the statusLine can show it
//
// The census is not a consolation prize. The hook cannot open a database
// inside HOOK_BUDGET_MS (50ms — bare Node start-up is most of it), so
// somebody has to pay for those counts out of band, and this is the process
// that already has the database open.
//
// It always exits 0. It is spawned detached with `stdio: "ignore"`, so its
// exit code is read by nothing and its stderr goes nowhere; a failure is
// recorded in status.json's `lastError` instead, which is the only place
// anyone will ever see it.

import type { ExitCode } from "../../app.ts";
import { EXIT_CODES } from "../../core/cli/exit-codes.ts";
import { describeError } from "../../core/errors/format-zod-error.ts";
import type { ResolvedConfig } from "../../core/config/resolve.ts";
import { finishedStatus, runningStatus } from "../../core/worker/status.ts";
import { takeLock } from "../../io/worker/lock.ts";
import { readStatus, writeStatus } from "../../io/worker/status-file.ts";
import { reviewCensus } from "../with-run.ts";
import type { OpenRun } from "../run-port.ts";
import { runIndex } from "./index.ts";

export interface WorkerInput {
  config: ResolvedConfig;
  repoRoot: string;
  openRun: OpenRun;
  stderr: NodeJS.WritableStream;
  now(): Date;
  /** The hook holds the lock and is handing it over — see io/worker/lock.ts. */
  adoptLock: boolean;
}

export async function runWorker(input: WorkerInput): Promise<ExitCode> {
  const { config, repoRoot } = input;

  const lock = takeLock({
    lockfile: config.paths.lockfile,
    stateDir: config.paths.stateDir,
    pid: process.pid,
    now: input.now(),
    adopt: input.adoptLock,
  });
  if (!lock.held) {
    // Another worker is mid-run. Two of them would race on the same rows.
    return EXIT_CODES.ok;
  }

  // The watermark and the judged sessions are the run commands' half of this
  // file (src/cli/with-run.ts), and both of the writes below replace the file
  // whole. Carry them across or a background reindex erases the hook's memory
  // of what has been judged.
  const previous = readStatus(config.paths.statuslineState);

  writeStatus(
    config.paths.statuslineState,
    runningStatus(
      input.now(),
      previous?.lastRunFinishedAt,
      previous?.runProgress,
      previous?.judgedSessions,
      previous?.unpublishedSessions,
    ),
  );

  let indexedAt: Date | undefined;
  let error: string | undefined;
  let eligibleSessions = 0;
  let threadsWaiting = 0;
  let reviewExpiresAt: Date | undefined;

  try {
    // `rebuildIndex` consults `shouldReindex` itself and returns without
    // building an embedder when the corpus hash and the model both match, so
    // the common case — a repo whose signposts have not moved — costs a hash
    // and a query. The hook's mtime check is only a cheap shadow of this one,
    // and this is the authority: a wake it disagrees with ends here.
    const code = await runIndex({ config, repoRoot, stderr: input.stderr });
    if (code === EXIT_CODES.ok) {
      indexedAt = input.now();
    } else {
      error = `index rebuild exited ${code}`;
    }

    const counts = await census(input);
    eligibleSessions = counts.eligibleSessions;
    threadsWaiting = counts.threadsWaiting;
    reviewExpiresAt = counts.reviewExpiresAt;
    if (counts.reason !== undefined) {
      error = counts.reason;
    }
  } catch (unexpected) {
    error = describeError(unexpected);
  } finally {
    // Re-read rather than reuse what was read at the top. A rebuild loads an
    // ONNX pipeline and embeds the corpus, so minutes can pass here, and only
    // the worker takes `paths.lockfile` — `run`, `resume` and `review` write
    // this file throughout. Carrying the opening read forward would put back a
    // `runProgress` that a run has since cleared, leaving the bar reporting a
    // finished run's count until it ages out.
    const current = readStatus(config.paths.statuslineState);
    writeStatus(
      config.paths.statuslineState,
      finishedStatus({
        now: input.now(),
        eligibleSessions,
        threadsWaiting,
        reviewExpiresAt,
        indexedAt,
        error,
        lastRunFinishedAt: current?.lastRunFinishedAt,
        runProgress: current?.runProgress,
        judgedSessions: current?.judgedSessions,
        unpublishedSessions: current?.unpublishedSessions,
      }),
    );
    lock.release();
  }

  // Always 0: nothing reads this, and a non-zero code from a process the user
  // never started is a false alarm looking for somewhere to be reported.
  return EXIT_CODES.ok;
}

interface Census {
  eligibleSessions: number;
  threadsWaiting: number;
  reviewExpiresAt?: Date;
  /** Why the census is zeroes rather than counted, when it could not be taken. */
  reason?: string;
}

/**
 * What is waiting for a person, counted once so the hook does not have to.
 *
 * Both numbers come off the same RunHandle the run commands use, which is
 * what keeps them honest: `eligible` applies the real eligibility gate
 * including the processed-keys check the hook can only approximate, and
 * `pendingReviews` judges checkpoints with the same `decideCheckpoint` a
 * resume would, so a thread this build could not resume is not counted as
 * though someone could answer it.
 */
async function census(input: WorkerInput): Promise<Census> {
  const opened = await input.openRun({
    config: input.config,
    repoRoot: input.repoRoot,
    warn: () => {
      // Nothing here has anyone to tell, and since the census stopped dropping
      // expired threads (19-value-to-a-user.md item 3) nothing here warns either.
    },
  });
  if ("reason" in opened) {
    // No GitHub origin, or no `git config user.email`. Not this process's
    // problem to report — `doctor` is the command that explains it.
    return { eligibleSessions: 0, threadsWaiting: 0, reason: opened.reason };
  }

  const handle = opened.handle;
  try {
    const now = input.now();
    return {
      eligibleSessions: handle.eligible(now).length,
      ...(await reviewCensus(handle, now)),
    };
  } finally {
    handle.close();
  }
}
