// `signpost sessions`, `signpost run` and `signpost resume` — the three
// commands the skill drives.
//
// A run proceeds in halts. `run` starts a session and stops at the first
// thing only the session outside can supply; `resume` hands the answers back
// and continues to the next halt. Each invocation is one process: the thread
// lives in the checkpointer, so nothing has to stay in memory between them,
// and a session halted on a review can be answered days later by a process
// that never saw this one.
//
// Every command prints one JSON object and exits. That is what makes them
// drivable from a skill without parsing prose.
//
// Nothing here opens a database, a checkpointer or an embedder. `openRun`
// does (../run-port.ts), wired at the composition root like every other port,
// and closed again whatever the command did with it.

import { readFileSync } from "node:fs";
import type { ExitCode } from "../../app.ts";
import type { ResolvedConfig } from "../../core/config/resolve.ts";
import { JSON_INDENT } from "../../core/config/constants.ts";
import { parseReplies } from "../../core/cli/replies.ts";
import { pendingProposals } from "../../core/graph/pending.ts";
import { OPERATION_TAGS } from "../../core/contracts/graph.ts";
import { resumeRun, startRun, type RunResult } from "../../graph/index.ts";
import type { RunOutput, SessionRef, SessionsOutput } from "../protocol.ts";
import { isUnavailable, type OpenRun, type RunHandle, type RunSession } from "../run-port.ts";

export interface RunCommandInput {
  config: ResolvedConfig;
  repoRoot: string;
  openRun: OpenRun;
  /** The session to act on; `run` defaults to the oldest eligible one. */
  sessionId?: string;
  /**
   * The session's content hash, as `sessions`/`run` reported it. Half of the
   * thread id, so `resume` takes it back rather than re-deriving it from a
   * file that may have moved since the halt.
   */
  contentHash?: string;
  /** `signpost resume --replies <path>`; `-` reads stdin. */
  repliesPath?: string;
  /** First session of a fresh run: drop what the last run left pending. */
  isFirst?: boolean;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

function write(stream: NodeJS.WritableStream, value: unknown): void {
  stream.write(`${JSON.stringify(value, null, JSON_INDENT)}\n`);
}

function fail(input: RunCommandInput, message: string): ExitCode {
  input.stderr.write(`signposts: ${message}\n`);
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
async function withRun(
  input: RunCommandInput,
  body: (handle: RunHandle) => Promise<ExitCode>,
): Promise<ExitCode> {
  const opened = await input.openRun({
    config: input.config,
    repoRoot: input.repoRoot,
    warn: (message) => input.stderr.write(`${message}\n`),
  });
  if (isUnavailable(opened)) {
    return fail(input, opened.reason);
  }

  try {
    return await body(opened.handle);
  } catch (error) {
    return fail(input, error instanceof Error ? error.message : String(error));
  } finally {
    opened.handle.close();
  }
}

function toRef(session: RunSession): SessionRef {
  return {
    sessionId: session.sessionId,
    contentHash: session.contentHash,
    transcriptPath: session.transcriptPath,
  };
}

/** Lists what a run would process, without starting one. */
export function runSessionsList(input: RunCommandInput): Promise<ExitCode> {
  return withRun(input, async (handle) => {
    const output: SessionsOutput = { sessions: handle.eligible(new Date()).map(toRef) };
    write(input.stdout, output);
    return 0;
  });
}

/** Starts (or restarts) one session and runs it to its first halt. */
export function runExtraction(input: RunCommandInput): Promise<ExitCode> {
  return withRun(input, async (handle) => {
    const session = pick(input, handle);
    if (session === undefined) {
      return fail(input, "no eligible session to run");
    }
    if (input.isFirst === true) {
      // What the last run left pending describes proposals that have since
      // merged or been rejected; a rejected one left in the index would be
      // retrieved by every later run as though a person had approved it.
      await handle.pendingIndex.clear(handle.repo);
    }

    const result = await startRun(handle.graph, handle.checkpointer, {
      repo: handle.repo,
      repoRoot: input.repoRoot,
      sessionId: session.sessionId,
      contentHash: session.contentHash,
      transcriptPath: session.transcriptPath,
    });
    return report(input, handle, session, result);
  });
}

/** Answers what a halted session asked for and continues it. */
export function runResume(input: RunCommandInput): Promise<ExitCode> {
  return withRun(input, async (handle) => {
    const session = resuming(input) ?? pick(input, handle);
    if (session === undefined) {
      return fail(
        input,
        "no session to resume — pass --session <id> --content-hash <hash>, as the halt reported them",
      );
    }
    if (input.repliesPath === undefined) {
      return fail(input, "resume needs --replies <path> (or - for stdin)");
    }

    const replies = parseReplies(
      readFileSync(input.repliesPath === "-" ? 0 : input.repliesPath, "utf8"),
    );
    const result = await resumeRun(
      handle.graph,
      handle.checkpointer,
      { repo: handle.repo, sessionId: session.sessionId, contentHash: session.contentHash },
      replies,
    );
    return report(input, handle, session, result);
  });
}

/** The named session, or the oldest eligible one when none was named. */
function pick(input: RunCommandInput, handle: RunHandle): RunSession | undefined {
  // A session halted mid-run is not finished, so it is still eligible here and
  // `run` can find it by id.
  const sessions = handle.eligible(new Date());
  return input.sessionId === undefined
    ? sessions[0]
    : sessions.find((session) => session.sessionId === input.sessionId);
}

/**
 * The session a resume is about, from what the caller was told rather than
 * from the file.
 *
 * The thread id is the repo, the session id and the content hash, so
 * re-deriving the hash makes a resume depend on the transcript not having
 * moved since the halt. It moves easily: the developer carries on in that
 * Claude Code session, or resumes it, and the file grows. Both halves of the
 * failure are misleading — the recomputed thread id does not exist ("cannot
 * be resumed by this build"), and the fresh mtime fails the idle gate, so a
 * caller who passed `--session` is told there is no session to resume. What
 * the halt reported is what identifies it.
 */
function resuming(input: RunCommandInput): RunSession | undefined {
  if (input.sessionId === undefined || input.contentHash === undefined) {
    return undefined;
  }
  return {
    sessionId: input.sessionId,
    contentHash: input.contentHash,
    // Neither is used by a resume: the transcript was read when the run
    // started, and the session is recorded as finished only when it is.
    transcriptPath: "",
    lastActivityAt: new Date(),
  };
}

/**
 * Prints what happened, indexes whatever the session has proposed so far, and
 * records it as finished once it is done.
 *
 * The two are deliberately not the same moment. Proposals are indexed as soon
 * as they exist — including while the session sits at a review — because the
 * next session must retrieve against them: a review that takes three days
 * must not make a claim invisible for three days, and without this the run
 * produces two near-identical `add`s that no classifier ever compared
 * (06-review-and-pr.md, "Reindex within a run, not only at commit"). Being
 * recorded as finished is the opposite: it happens only when the session is,
 * since a finished session is one no later run picks up.
 */
async function report(
  input: RunCommandInput,
  handle: RunHandle,
  session: RunSession,
  result: RunResult,
): Promise<ExitCode> {
  const waiting = result.pending.length > 0;

  const proposals = pendingProposals(result.state.gated);
  if (proposals.length > 0) {
    await handle.pendingIndex.indexPending(handle.repo, proposals);
  }

  if (!waiting) {
    handle.finish({
      sessionId: session.sessionId,
      contentHash: session.contentHash,
      lastActivityAt: session.lastActivityAt,
      tokenEstimate: result.state.gutterStats.tokenEstimate,
    });
  }

  const output: RunOutput = {
    sessionId: session.sessionId,
    status: waiting ? "waiting" : "finished",
    pending: result.pending,
    proposed: waiting ? [] : result.state.operations.map(describe),
  };
  write(input.stdout, output);
  return 0;
}

function describe(operation: RunResult["state"]["operations"][number]): string {
  return operation.op === OPERATION_TAGS.add
    ? `${operation.op} ${operation.signpost.id}: ${operation.signpost.claim}`
    : operation.op === OPERATION_TAGS.supersede
      ? `${operation.op} ${operation.id} with ${operation.replacement.id}`
      : `${operation.op} ${operation.id}`;
}
