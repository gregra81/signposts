// Which threads are halted and can be resumed, found by reading the checkpoint
// database rather than by remembering anything.
//
// `signpost run` reports a halt to whoever invoked it and exits, and the
// `resume` that answers it may be a different process. So the list is
// *derived*: every thread in the checkpoint database, judged by the same rules
// a resume is judged by (decideCheckpoint), so a thread this build cannot
// resume is never offered.

import type {
  BaseCheckpointSaver,
  CheckpointTuple,
  LangGraphRunnableConfig,
} from "@langchain/langgraph";
import { decideCheckpoint } from "../../core/graph/state-version.ts";
import {
  pendingOnThread,
  threadConfigFor,
  type ExtractionGraph,
  type PendingRequest,
} from "../../graph/index.ts";

export interface HaltedSessionsInput {
  graph: ExtractionGraph;
  checkpointer: BaseCheckpointSaver;
  /** Only this repo's threads: the checkpoint file is per repo, but a stray one is not this repo's business. */
  repo: string;
  now: Date;
}

/** What a checkpoint carries about the session it belongs to. */
interface ThreadIdentity {
  repo: string;
  sessionId: string;
  contentHash: string;
}

/** A session whose thread is halted on a model call and can be resumed. */
export interface HaltedSession {
  sessionId: string;
  /** The hash the thread was built from, which is the one its halt reported. */
  contentHash: string;
  waitingSince: Date;
}

/**
 * Every session in this repo whose thread is halted and this build can resume,
 * longest-waiting first.
 *
 * What lets `resume` go without `--content-hash` (19-value-to-a-user.md, open
 * item 2). The hash is on the thread, and it is the one the halt reported: the
 * transcript may have grown since, and hashing it again would name a different
 * thread. An expired thread is not one of these, because `resumeRun` refuses
 * it; nothing is dropped here either, since this is not a person reading.
 */
export async function listHaltedSessions(
  input: HaltedSessionsInput,
): Promise<HaltedSession[]> {
  const halted: HaltedSession[] = [];
  for await (const { identity, tuple, decision } of haltedThreads(input)) {
    if (decision.action !== "resume") {
      continue;
    }
    halted.push({
      sessionId: identity.sessionId,
      contentHash: identity.contentHash,
      waitingSince: new Date(tuple.checkpoint.ts),
    });
  }
  return halted.sort((left, right) => left.waitingSince.getTime() - right.waitingSince.getTime());
}

/** One of this repo's threads with something pending, and how `decideCheckpoint` judged it. */
interface HaltedThread {
  threadId: string;
  identity: ThreadIdentity;
  tuple: CheckpointTuple;
  decision: ReturnType<typeof decideCheckpoint>;
  pending: PendingRequest[];
}

/**
 * This repo's threads that are halted on anything, resumable or expired.
 *
 * What `resume`'s lookup walks.
 */
async function* haltedThreads(
  input: HaltedSessionsInput,
): AsyncGenerator<HaltedThread> {
  for await (const tuple of newestPerThread(input.checkpointer)) {
    const threadId = tuple.config.configurable?.["thread_id"];
    if (typeof threadId !== "string") {
      continue;
    }

    // Whose thread it is, before anything is judged or deleted. The checkpoint
    // file is this repo's, but a thread that is not this repo's business is
    // not this listing's to drop either.
    const identity = identify(tuple.checkpoint.channel_values);
    if (identity === undefined || identity.repo !== input.repo) {
      continue;
    }

    const decision = decideCheckpoint(tuple.checkpoint.channel_values, {
      checkpointedAt: tuple.checkpoint.ts,
      now: input.now,
    });
    if (decision.action !== "resume" && decision.action !== "expired") {
      continue;
    }

    const pending = await pendingOnThread(input.graph, threadConfigFor(threadId));
    if (pending.length === 0) {
      continue;
    }
    yield { threadId, identity, tuple, decision, pending };
  }
}

/** How many checkpoints one query pulls back. See `newestPerThread`. */
const SCAN_PAGE = 64;

/**
 * The latest checkpoint of each thread, a page at a time.
 *
 * `list` with no thread_id walks every thread, newest checkpoint first
 * (`ORDER BY checkpoint_id DESC`, and checkpoint ids are time-ordered), so the
 * first row seen for a thread is its current one. The namespace is pinned to
 * the root: a subgraph's checkpoint carries its own channel values, which have
 * neither the version nor the session this reads.
 *
 * Paged rather than taken in one call, because the SQLite saver materialises
 * its whole result set — `.all()` — and deserialises every checkpoint blob in
 * it before the first `yield`. Unpaged, that is every superstep of every run
 * this repo has ever done held in memory at once, to find the handful of
 * threads that are halted. `before` is exclusive (`checkpoint_id < ?`), so
 * each page picks up where the last one stopped.
 *
 * The walk is still proportional to history rather than to what is waiting,
 * which is bounded by nothing deleting a finished run's thread. If that ever
 * becomes the cost that matters, pruning at `commit` is the fix, not a bigger
 * page.
 */
async function* newestPerThread(
  checkpointer: BaseCheckpointSaver,
): AsyncGenerator<CheckpointTuple> {
  const seen = new Set<string>();
  let before: LangGraphRunnableConfig | undefined;

  for (;;) {
    let read = 0;
    let last: string | undefined;

    for await (const tuple of checkpointer.list(
      { configurable: { checkpoint_ns: "" } },
      { limit: SCAN_PAGE, ...(before === undefined ? {} : { before }) },
    )) {
      read += 1;
      const checkpointId = tuple.config.configurable?.["checkpoint_id"];
      if (typeof checkpointId === "string") {
        last = checkpointId;
      }
      const threadId = tuple.config.configurable?.["thread_id"];
      if (typeof threadId === "string" && !seen.has(threadId)) {
        seen.add(threadId);
        yield tuple;
      }
    }

    if (read < SCAN_PAGE || last === undefined) {
      return;
    }
    before = { configurable: { checkpoint_id: last } };
  }
}

/**
 * The repo, session and content hash the checkpoint was written with.
 *
 * All three are on the state the run seeded (`initialState`), so a checkpoint
 * missing any of them is not one a resume could address — the thread id is
 * built from exactly these. Undefined rather than a throw: one malformed
 * thread must not take the whole listing down.
 */
function identify(values: Record<string, unknown> | undefined): ThreadIdentity | undefined {
  const repo = values?.["repo"];
  const sessionId = values?.["sessionId"];
  const contentHash = values?.["contentHash"];
  if (
    typeof repo !== "string" ||
    typeof sessionId !== "string" ||
    typeof contentHash !== "string"
  ) {
    return undefined;
  }
  return { repo, sessionId, contentHash };
}
