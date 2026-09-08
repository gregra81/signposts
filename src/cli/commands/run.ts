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
import { OPERATION_TAGS } from "../../core/contracts/graph.ts";
import { resumeRun, startRun, type RunResult } from "../../graph/index.ts";
import type { RunOutput, SessionRef, SessionsOutput } from "../protocol.ts";
import type { OpenRun, RunHandle, RunSession } from "../run-port.ts";
import { fail, namedSession, settle, withRun } from "../with-run.ts";

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
      return fail(input.stderr, "no eligible session to run");
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
    const session = resuming(input, handle) ?? pick(input, handle);
    if (session === undefined) {
      return fail(
        input.stderr,
        "no session to resume — pass --session <id> --content-hash <hash>, as the halt reported them",
      );
    }
    if (input.repliesPath === undefined) {
      return fail(input.stderr, "resume needs --replies <path> (or - for stdin)");
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
 * from the file — `namedSession` in ../with-run.ts explains why both halves of
 * the thread id have to be handed back rather than re-derived.
 */
function resuming(input: RunCommandInput, handle: RunHandle): RunSession | undefined {
  if (input.sessionId === undefined || input.contentHash === undefined) {
    return undefined;
  }
  return namedSession(handle, input.sessionId, input.contentHash, new Date());
}

/** Prints what happened, and settles what the run left behind (../with-run.ts). */
async function report(
  input: RunCommandInput,
  handle: RunHandle,
  session: RunSession,
  result: RunResult,
): Promise<ExitCode> {
  await settle(handle, session, result);

  const waiting = result.pending.length > 0;
  const output: RunOutput = {
    sessionId: session.sessionId,
    contentHash: session.contentHash,
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
