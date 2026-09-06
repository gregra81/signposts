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

import { readFileSync } from "node:fs";
import type { ExitCode } from "../../app.ts";
import type { ResolvedConfig } from "../../core/config/resolve.ts";
import { JSON_INDENT } from "../../core/config/constants.ts";
import { parseReplies } from "../../core/cli/replies.ts";
import { pendingProposals } from "../../core/graph/pending.ts";
import { OPERATION_TAGS } from "../../core/contracts/graph.ts";
import { buildExtractionGraph, resumeRun, startRun, type RunResult } from "../../graph/index.ts";
import type { RunOutput, SessionRef, SessionsOutput } from "../protocol.ts";
import { openCheckpointer } from "../../io/db/checkpointer.ts";
import { openDb } from "../../io/db/migrate.ts";
import { markProcessed, processedKeys } from "../../io/db/sessions.ts";
import { createEmbedder } from "../../io/embed/embedder.ts";
import { makeCommitPort } from "../../io/commit/commit-port.ts";
import { ghForge } from "../../io/forge/gh-forge.ts";
import { authorEmail } from "../../io/git/worktree.ts";
import { resolveRepo } from "../../io/git/remote-origin.ts";
import { buildGraphPorts } from "../../io/graph-ports.ts";
import { discoverSessions, type DiscoveredSession } from "../../io/transcript/discover.ts";
import { EMBEDDING_MODEL } from "../../core/config/constants.ts";

export interface RunCommandInput {
  config: ResolvedConfig;
  repoRoot: string;
  /** The session to act on; `run` defaults to the oldest eligible one. */
  sessionId?: string;
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

/** Lists what a run would process, without starting one. */
export function runSessionsList(input: RunCommandInput): ExitCode {
  const repo = resolveRepo(input.repoRoot);
  if (repo === null) {
    return fail(input, NO_REPO);
  }

  const db = openDb(input.config.paths.dbPath);
  try {
    const sessions = discoverSessions({
      transcriptRoot: input.config.paths.transcriptRoot,
      repoRoot: input.repoRoot,
      processedKeys: processedKeys(db, repo),
      now: new Date(),
    });
    const output: SessionsOutput = { sessions: sessions.map(toRef) };
    write(input.stdout, output);
    return 0;
  } finally {
    db.close();
  }
}

/** Starts (or restarts) one session and runs it to its first halt. */
export async function runExtraction(input: RunCommandInput): Promise<ExitCode> {
  return withRun(input, async (context) => {
    const session = await pick(input, context);
    if (session === undefined) {
      return fail(input, "no eligible session to run");
    }
    if (input.isFirst === true) {
      // What the last run left pending describes proposals that have since
      // merged or been rejected; a rejected one left in the index would be
      // retrieved by every later run as though a person had approved it.
      await context.ports.pendingIndex.clear(context.repo);
    }
    const result = await startRun(context.graph, context.checkpointer, {
      repo: context.repo,
      repoRoot: input.repoRoot,
      sessionId: session.sessionId,
      contentHash: session.contentHash,
      transcriptPath: session.transcriptPath,
    });
    return report(input, context, session, result);
  });
}

/** Answers what a halted session asked for and continues it. */
export async function runResume(input: RunCommandInput): Promise<ExitCode> {
  return withRun(input, async (context) => {
    const session = await pick(input, context);
    if (session === undefined) {
      return fail(input, "no session to resume — pass --session <id>");
    }
    if (input.repliesPath === undefined) {
      return fail(input, "resume needs --replies <path> (or - for stdin)");
    }

    const replies = parseReplies(
      readFileSync(input.repliesPath === "-" ? 0 : input.repliesPath, "utf8"),
    );
    const result = await resumeRun(
      context.graph,
      context.checkpointer,
      { repo: context.repo, sessionId: session.sessionId, contentHash: session.contentHash },
      replies,
    );
    return report(input, context, session, result);
  });
}

const NO_REPO =
  "could not determine repo (owner/name) from the 'origin' git remote — is this a git repo with a GitHub origin configured?";

function fail(input: RunCommandInput, message: string): ExitCode {
  input.stderr.write(`signposts: ${message}\n`);
  return 1;
}

function toRef(session: DiscoveredSession): SessionRef {
  return {
    sessionId: session.sessionId,
    contentHash: session.contentHash,
    transcriptPath: session.transcriptPath,
  };
}

interface RunContext {
  repo: string;
  graph: ReturnType<typeof buildExtractionGraph>;
  checkpointer: ReturnType<typeof openCheckpointer>["checkpointer"];
  ports: ReturnType<typeof buildGraphPorts>;
  db: ReturnType<typeof openDb>;
}

/**
 * Opens everything a run needs, hands it over, and closes it again.
 *
 * One database handle, one embedder and one checkpointer per invocation:
 * building the embedder loads an ONNX pipeline, so a command that built one
 * per session would pay that for every halt.
 */
async function withRun(
  input: RunCommandInput,
  body: (context: RunContext) => Promise<ExitCode>,
): Promise<ExitCode> {
  const repo = resolveRepo(input.repoRoot);
  if (repo === null) {
    return fail(input, NO_REPO);
  }
  const author = authorEmail(input.repoRoot);
  if (author === null) {
    return fail(input, "git config user.email is not set — signposts records it as provenance");
  }

  const db = openDb(input.config.paths.dbPath);
  const { checkpointer, close: closeCheckpointer } = openCheckpointer(input.config.paths.checkpointPath);
  try {
    const embedder = await createEmbedder({
      modelCacheDir: input.config.paths.modelCacheDir,
      allowRemoteModels: input.config.retrieval.allow_remote_models,
      localModelPath: input.config.retrieval.local_model_path,
      embeddingModel: EMBEDDING_MODEL,
    });

    const ports = buildGraphPorts({
      db,
      embedder,
      repo,
      repoRoot: input.repoRoot,
      neighbourK: input.config.retrieval.k,
      author,
      now: () => new Date(),
      commit: makeCommitPort({
        repoRoot: input.repoRoot,
        worktreeDir: input.config.paths.worktreeDir,
        branchPattern: input.config.git.branch_pattern,
        author,
        forge: ghForge(input.config.paths.worktreeDir),
        warn: (message) => input.stderr.write(`${message}\n`),
        today: () => isoDate(new Date()),
      }),
    });

    const graph = buildExtractionGraph({ ports, checkpointer });
    return await body({ repo, graph, checkpointer, ports, db });
  } finally {
    closeCheckpointer();
    db.close();
  }
}

/** `2026-09-05` — the ISO date `reinforce` records, without the time. */
function isoDate(now: Date): string {
  return now.toISOString().split("T")[0]!;
}

/** The named session, or the oldest eligible one when none was named. */
async function pick(
  input: RunCommandInput,
  context: RunContext,
): Promise<DiscoveredSession | undefined> {
  const sessions = discoverSessions({
    transcriptRoot: input.config.paths.transcriptRoot,
    repoRoot: input.repoRoot,
    // A session halted mid-run is not "processed", so it is still discovered
    // here and `resume` can find it by id.
    processedKeys: processedKeys(context.db, context.repo),
    now: new Date(),
  });
  return input.sessionId === undefined
    ? sessions[0]
    : sessions.find((session) => session.sessionId === input.sessionId);
}

/**
 * Prints what happened, and records a finished session.
 *
 * A session is only marked processed and its proposals indexed once it
 * finishes: a halted one has proposed nothing yet, and marking it would make
 * the next run skip a thread nobody answered.
 */
async function report(
  input: RunCommandInput,
  context: RunContext,
  session: DiscoveredSession,
  result: RunResult,
): Promise<ExitCode> {
  const waiting = result.pending.length > 0;

  if (!waiting) {
    const proposals = pendingProposals(result.state.gated);
    if (proposals.length > 0) {
      await context.ports.pendingIndex.indexPending(context.repo, proposals);
    }
    markProcessed(context.db, {
      sessionId: session.sessionId,
      contentHash: session.contentHash,
      repo: context.repo,
      repoRoot: input.repoRoot,
      lastActivityAt: session.lastActivityAt.toISOString(),
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
