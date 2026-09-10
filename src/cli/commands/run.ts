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
import { EXIT_CODES } from "../../core/cli/exit-codes.ts";
import { OPERATION_TAGS } from "../../core/contracts/graph.ts";
import { REVIEW_REQUEST_KIND, resumeRun, startRun, type RunResult } from "../../graph/index.ts";
import type { RunOutput, SessionRef, SessionsOutput } from "../protocol.ts";
import type { OpenRun, RunHandle, RunSession } from "../run-port.ts";
import { fail, namedSession, settle, withRun } from "../with-run.ts";
import {
  contextLines,
  eligibleLine,
  finishedLines,
  haltedLines,
  resumingLine,
  sessionLine,
  startingLine,
  type VerboseSession,
} from "../../core/cli/verbose.ts";

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
  /**
   * `--verbose`: narrate what is happening on stderr, for a person driving
   * the loop without the skill (15-spec.md story 71). stdout is untouched —
   * it is still exactly one JSON object.
   */
  verbose?: boolean;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

function write(stream: NodeJS.WritableStream, value: unknown): void {
  stream.write(`${JSON.stringify(value, null, JSON_INDENT)}\n`);
}

/**
 * The `--verbose` narrator, or a no-op.
 *
 * Everything it writes goes to stderr and is prefixed the way `fail` prefixes
 * its own line, so a terminal holding both a trace and an error reads as one
 * program talking.
 *
 * It takes a thunk rather than the lines themselves, so that a plain run pays
 * nothing to build a trace nobody prints. That is not a micro-optimisation:
 * `handle.eligible()` re-reads and sha256s every transcript in this repo's
 * project directory, and an eagerly evaluated argument made every
 * `signpost run` pay for it a second time.
 */
function tracer(input: RunCommandInput): (lines: () => string | readonly string[]) => void {
  if (input.verbose !== true) {
    return () => {};
  }
  return (lines) => {
    const written = lines();
    for (const line of typeof written === "string" ? [written] : written) {
      input.stderr.write(`signposts: ${line}\n`);
    }
  };
}

/** A session in the shape ../../core/cli/verbose.ts prints, dates already formatted. */
function traceable(session: RunSession): VerboseSession {
  return {
    sessionId: session.sessionId,
    contentHash: session.contentHash,
    transcriptPath: session.transcriptPath,
    lastActivityAt: session.lastActivityAt.toISOString(),
  };
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
  const trace = tracer(input);
  return withRun(input, async (handle) => {
    trace(() => contextLines({ repo: handle.repo, stateDir: input.config.paths.stateDir }));
    const sessions = handle.eligible(new Date());
    trace(() => [eligibleLine(sessions.length), ...sessions.map((session) => sessionLine(traceable(session)))]);
    const output: SessionsOutput = { sessions: sessions.map(toRef) };
    write(input.stdout, output);
    return 0;
  });
}

/** Starts (or restarts) one session and runs it to its first halt. */
export function runExtraction(input: RunCommandInput): Promise<ExitCode> {
  const trace = tracer(input);
  return withRun(input, async (handle) => {
    trace(() => contextLines({ repo: handle.repo, stateDir: input.config.paths.stateDir }));
    const session = pick(input, handle);
    if (session === undefined) {
      return fail(input.stderr, "no eligible session to run");
    }
    trace(() => startingLine(traceable(session)));
    if (input.isFirst === true) {
      // What the last run left pending describes proposals that have since
      // merged or been rejected; a rejected one left in the index would be
      // retrieved by every later run as though a person had approved it.
      await handle.pendingIndex.clear(handle.repo);

      // And what has merged since the last run has to reach the index before
      // this one starts classifying against it. 05-retrieval.md says the index
      // self-heals; nothing on this path made it, so `classify` was handed an
      // empty neighbour list in a repo full of signposts and called everything
      // NOVEL (18-end-to-end-gaps.md, item 2). Here rather than anywhere later
      // in the run, because the sync deletes every row not on disk and the
      // pending rows the run is about to write are never on disk.
      const { failures } = await handle.syncCorpus();
      for (const failure of failures) {
        // Not fatal: `signpost index` turns a file that will not parse into an
        // exit code, and a run has better things to be than blocked on one.
        input.stderr.write(`signposts: ${failure}\n`);
      }
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
  const trace = tracer(input);
  return withRun(input, async (handle) => {
    trace(() => contextLines({ repo: handle.repo, stateDir: input.config.paths.stateDir }));
    const session = resuming(input, handle) ?? pick(input, handle);
    if (session === undefined) {
      return fail(
        input.stderr,
        "no session to resume — pass --session <id> --content-hash <hash>, as the halt reported them",
      );
    }
    const repliesPath = input.repliesPath;
    if (repliesPath === undefined) {
      return fail(input.stderr, "resume needs --replies <path> (or - for stdin)");
    }

    const replies = parseReplies(readFileSync(repliesPath === "-" ? 0 : repliesPath, "utf8"));
    trace(() => resumingLine(traceable(session), repliesPath, Object.keys(replies).length));
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
  await settle({
    handle,
    session,
    result,
    statusPath: input.config.paths.statuslineState,
    now: new Date(),
    isFirst: input.isFirst === true,
  });

  const waiting = result.pending.length > 0;
  const trace = tracer(input);
  const proposed = waiting ? [] : result.state.operations.map(describe);
  trace(() =>
    waiting
      ? haltedLines(
          traceable(session),
          result.pending.map((pending) => ({
            kind: pending.request.kind,
            node: pending.request.kind === REVIEW_REQUEST_KIND ? undefined : pending.request.node,
            interruptId: pending.id,
          })),
        )
      : finishedLines(proposed, handle.eligible(new Date()).length),
  );

  const output: RunOutput = {
    sessionId: session.sessionId,
    contentHash: session.contentHash,
    status: waiting ? "waiting" : "finished",
    pending: result.pending,
    proposed,
    commit: handle.commitOutcome(),
  };
  write(input.stdout, output);
  return exitCode(handle, result);
}

/**
 * What the invocation reports to whatever ran it (12-wire-contracts.md, "Exit
 * codes").
 *
 * Neither of the two non-zero codes here is a failure, and that is the whole
 * point of them: a hook or a CI step that treats non-zero as fatal must not
 * raise an alarm because a person has a review to answer, or because the work
 * is safely committed on a branch that `gh` was not around to open a pull
 * request for. Both are reported alongside the same JSON object every other
 * outcome prints — `status` and `pending` are unchanged, the exit code is the
 * part a caller that does not parse JSON can still read.
 *
 * A halt on a model call is *not* one of them: the session driving the loop
 * answers those itself, and it is told to by `status: "waiting"`.
 */
function exitCode(handle: RunHandle, result: RunResult): ExitCode {
  if (handle.commitOutcome()?.manualCommand != null) {
    return EXIT_CODES.prCreationFailed;
  }
  if (result.pending.some((pending) => pending.request.kind === REVIEW_REQUEST_KIND)) {
    return EXIT_CODES.awaitingHuman;
  }
  return EXIT_CODES.ok;
}

function describe(operation: RunResult["state"]["operations"][number]): string {
  return operation.op === OPERATION_TAGS.add
    ? `${operation.op} ${operation.signpost.id}: ${operation.signpost.claim}`
    : operation.op === OPERATION_TAGS.supersede
      ? `${operation.op} ${operation.id} with ${operation.replacement.id}`
      : `${operation.op} ${operation.id}`;
}
