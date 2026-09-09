// What every command that opens a run shares: opening it, closing it again,
// reporting a failure the way the caller can read, and the bookkeeping a run
// leaves behind once it has moved.
//
// `run`/`resume` print JSON for the skill and `review` prints prose for a
// person, so their output has nothing in common — but what happens around it
// does, and getting that wrong is what these exist to prevent: a database
// handle left open, a throw escaping as a stack trace, a session that finished
// without being recorded and is therefore extracted again tomorrow.

import type { ExitCode } from "../app.ts";
import type { ResolvedConfig } from "../core/config/resolve.ts";
import { pendingProposals } from "../core/graph/pending.ts";
import type { RunResult } from "../graph/index.ts";
import { recordRunFinished, recordRunProgress } from "../io/worker/status-file.ts";
import {
  isUnavailable,
  type OpenedRun,
  type OpenRun,
  type RunHandle,
  type RunSession,
} from "./run-port.ts";

export interface OpenRunInput {
  config: ResolvedConfig;
  repoRoot: string;
  openRun: OpenRun;
  stderr: NodeJS.WritableStream;
}

/** How every command here reports something the user has to fix. */
export function fail(stderr: NodeJS.WritableStream, message: string): ExitCode {
  stderr.write(`signposts: ${message}\n`);
  return 1;
}

/**
 * Opens a run, hands it over, and closes it again whatever the body did.
 *
 * A throw is reported the way every other failure here is, through `fail`.
 * `bin/signpost.js` is a bare top-level `await` with no handler, so anything
 * that escaped arrived as a Node stack trace on stderr and nothing at all on
 * stdout — which breaks the one-JSON-object contract precisely where the
 * caller needs it. The ordinary errors are ordinary: a `--replies` path that
 * does not exist, a reply the answering session got the shape of wrong, a
 * resume against a halt the thread is not waiting on. The skill has to be
 * able to tell "your answer was rejected, redo it" from "signposts crashed",
 * and it reads that off `status`.
 */
export async function withRun(
  input: OpenRunInput,
  body: (handle: RunHandle) => Promise<ExitCode>,
): Promise<ExitCode> {
  // Opening is inside the guard too, not only the body. `openRun` builds the
  // database handle, the checkpointer and an embedder that loads an ONNX
  // pipeline, and re-throws after closing what it had already opened — so a
  // corrupt `signposts.db`, a model that cannot load offline, or a
  // `user.email` the slug rule rejects all throw from this one statement.
  // Catching only the body left the loudest failures as the ones that escaped.
  let opened: OpenedRun;
  try {
    opened = await input.openRun({
      config: input.config,
      repoRoot: input.repoRoot,
      warn: (message) => input.stderr.write(`${message}\n`),
    });
  } catch (error) {
    return fail(input.stderr, error instanceof Error ? error.message : String(error));
  }
  if (isUnavailable(opened)) {
    return fail(input.stderr, opened.reason);
  }

  try {
    return await body(opened.handle);
  } catch (error) {
    return fail(input.stderr, error instanceof Error ? error.message : String(error));
  } finally {
    opened.handle.close();
  }
}

export interface SettleInput {
  handle: RunHandle;
  session: RunSession;
  result: RunResult;
  /** `config.paths.statuslineState` — where the session watermark lives. */
  statusPath: string;
  now: Date;
}

/**
 * Indexes whatever the session has proposed so far, and records it as finished
 * once it is done.
 *
 * The two are deliberately not the same moment. Proposals are indexed as soon
 * as they exist — including while the session sits at a review — because the
 * next session must retrieve against them: a review that takes three days
 * must not make a claim invisible for three days, and without this the run
 * produces two near-identical `add`s that no classifier ever compared
 * (06-review-and-pr.md, "Reindex within a run, not only at commit"). Being
 * recorded as finished is the opposite: it happens only when the session is,
 * since a finished session is one no later run picks up.
 *
 * `signpost review` settles the same way `resume` does. A review answered in
 * the terminal is the invocation that finishes the session as often as not,
 * and a session that reached `commit` without being recorded stays eligible —
 * so the next run extracts a transcript whose signposts are already in the PR.
 *
 * Finishing the last of them also moves the session watermark, which is the
 * only thing that ever stops the SessionStart hook announcing the same backlog
 * at every session start: the hook cannot open a database, so `run` and
 * `review` are what tell it a transcript has been judged.
 */
export async function settle(input: SettleInput): Promise<void> {
  const { handle, session, result } = input;
  const proposals = pendingProposals(result.state.gated);
  if (proposals.length > 0) {
    await handle.pendingIndex.indexPending(handle.repo, proposals);
  }

  // Progress before the early return, because the halt is most of a run's
  // life: a session waiting on a review is the state the statusLine has to
  // keep rendering, and the stamp it writes here is what stops that line
  // ageing out while the developer is still answering (07, "Live progress").
  //
  // The census goes with it. `threadsWaiting` used to be the worker's alone,
  // and the worker runs only when a session starts — so a review this halt
  // parked a minute ago stayed invisible until the next `claude`, which is
  // precisely the state the developer needs to see. The count comes from
  // `pendingReviews`, the same source the worker's census uses.
  if (result.pending.length > 0) {
    recordRunProgress(input.statusPath, {
      now: input.now,
      remaining: handle.eligible(input.now).length,
      sessionFinished: false,
      found: 0,
      threadsWaiting: (await handle.pendingReviews(input.now)).length,
    });
    return;
  }

  handle.finish({
    sessionId: session.sessionId,
    contentHash: session.contentHash,
    lastActivityAt: session.lastActivityAt,
    tokenEstimate: result.state.gutterStats.tokenEstimate,
  });

  // `finish` above has already dropped this session out of `eligible`, so what
  // is left here is the run's remaining work and this session counts as done.
  const remaining = handle.eligible(input.now).length;
  recordRunProgress(input.statusPath, {
    now: input.now,
    remaining,
    sessionFinished: true,
    found: result.state.operations.length,
    // Retaken here too, and this is the direction that matters: answering the
    // last review is what takes the count back to zero, and nothing else in
    // the system would notice until a worker woke.
    threadsWaiting: (await handle.pendingReviews(input.now)).length,
  });

  // Only once nothing eligible is left, because the watermark is one date for
  // the whole repo: stamping it while an older unprocessed transcript is still
  // waiting silences the hook about that transcript for good. It clears the
  // progress with the same write — the run this was tracking is over.
  if (remaining === 0) {
    recordRunFinished(input.statusPath, session.lastActivityAt);
  }
}

/**
 * The session a command was told about, from what it was told rather than from
 * the file.
 *
 * The thread id is the repo, the session id and the content hash, so
 * re-deriving the hash makes an answer depend on the transcript not having
 * moved since the halt. It moves easily: the developer carries on in that
 * Claude Code session, or resumes it, and the file grows. Both halves of the
 * failure are misleading — the recomputed thread id does not exist ("cannot
 * be resumed by this build"), and the fresh mtime fails the idle gate, so a
 * caller who passed `--session` is told there is no session to resume. What
 * the halt reported is what identifies it.
 *
 * The listing is still consulted, but only for the two fields the ids do not
 * carry, and only when it agrees about the hash. A matching hash means the
 * file has not changed since the halt, so its recorded activity is the real
 * one. When it does not match — the developer carried on in that session —
 * the identity above still stands and these fall back.
 *
 * `lastActivityAt` matters because answering a halt can be the invocation
 * that finishes the session, and `settle` writes it to
 * `sessions.last_activity_at`. Filling it with the current time recorded the
 * moment the developer answered the last halt, which for a review answered
 * three days later is three days out. Nothing reads the column yet, and that
 * is the reason to keep it honest rather than to leave it wrong.
 */
export function namedSession(
  handle: RunHandle,
  sessionId: string,
  contentHash: string,
  now: Date,
): RunSession {
  const listed = handle
    .eligible(now)
    .find((session) => session.sessionId === sessionId && session.contentHash === contentHash);
  return {
    sessionId,
    contentHash,
    transcriptPath: listed?.transcriptPath ?? "",
    lastActivityAt: listed?.lastActivityAt ?? now,
  };
}
