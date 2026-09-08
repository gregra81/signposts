// Which threads are parked on a review, found by reading the checkpoint
// database rather than by remembering anything.
//
// `signpost run` reports a halt to whoever invoked it and exits. Days later
// the developer types `signpost review`, in a process that never saw that run
// and holds no list of what it left behind. So the list is *derived*: every
// thread in the checkpoint database, judged by the same rules a resume is
// judged by, filtered to the ones halted on `human_review`.
//
// The judging is deliberately the same code `startRun` and `resumeRun` use
// (decideCheckpoint). A thread this build cannot resume is not shown, because
// showing it would invite a decision that `resumeRun` then refuses; a thread
// past THREAD_EXPIRY_DAYS is dropped here and said so, for the reason
// 04-extraction-graph.md gives — its partition was computed against
// neighbours, ids and a bootstrap flag the repo has long since moved past, so
// there is nothing honest left to review.

import type { BaseCheckpointSaver, CheckpointTuple } from "@langchain/langgraph";
import type { PendingReview } from "../../cli/run-port.ts";
import { THREAD_EXPIRY_DAYS } from "../../core/config/constants.ts";
import { decideCheckpoint } from "../../core/graph/state-version.ts";
import {
  pendingOnThread,
  threadConfigFor,
  REVIEW_REQUEST_KIND,
  type ExtractionGraph,
  type PendingRequest,
  type ReviewRequest,
} from "../../graph/index.ts";

export interface PendingReviewsInput {
  graph: ExtractionGraph;
  checkpointer: BaseCheckpointSaver;
  /** Only this repo's threads: the checkpoint file is per repo, but a stray one is not this repo's business. */
  repo: string;
  now: Date;
  /** Where the drop of an expired thread is logged. */
  warn: (message: string) => void;
}

/** What a checkpoint carries about the session it belongs to. */
interface ThreadIdentity {
  repo: string;
  sessionId: string;
  contentHash: string;
}

export async function listPendingReviews(input: PendingReviewsInput): Promise<PendingReview[]> {
  const reviews: PendingReview[] = [];

  for (const tuple of await newestPerThread(input.checkpointer)) {
    const threadId = tuple.config.configurable?.["thread_id"];
    if (typeof threadId !== "string") {
      continue;
    }

    const decision = decideCheckpoint(tuple.checkpoint.channel_values, {
      checkpointedAt: tuple.checkpoint.ts,
      now: input.now,
    });
    if (decision.action === "expired") {
      input.warn(
        `Pending review for thread ${threadId} is ${decision.ageDays.toFixed(0)} days old ` +
          `(expiry ${String(THREAD_EXPIRY_DAYS)} days). Dropping it.`,
      );
      await input.checkpointer.deleteThread(threadId);
      continue;
    }
    if (decision.action !== "resume") {
      continue;
    }

    const identity = identify(tuple.checkpoint.channel_values);
    if (identity === undefined || identity.repo !== input.repo) {
      continue;
    }

    // The halt itself comes from the thread, not from the checkpoint payload:
    // the interrupt id is LangGraph's, and only the graph knows it.
    for (const request of await pendingOnThread(input.graph, threadConfigFor(threadId))) {
      if (!isReview(request)) {
        continue;
      }
      reviews.push({
        threadId,
        sessionId: identity.sessionId,
        contentHash: identity.contentHash,
        interruptId: request.id,
        waitingSince: new Date(tuple.checkpoint.ts),
        needsHuman: request.request.needsHuman,
      });
    }
  }

  // Longest-waiting first: the one most likely to be forgotten is the one the
  // developer is shown first.
  return reviews.sort((left, right) => left.waitingSince.getTime() - right.waitingSince.getTime());
}

/**
 * The latest checkpoint of each thread.
 *
 * `list` with no thread_id walks every thread, newest checkpoint first
 * (`ORDER BY checkpoint_id DESC`, and checkpoint ids are time-ordered), so the
 * first row seen for a thread is its current one. The namespace is pinned to
 * the root: a subgraph's checkpoint carries its own channel values, which have
 * neither the version nor the session this reads.
 */
async function newestPerThread(checkpointer: BaseCheckpointSaver): Promise<CheckpointTuple[]> {
  const newest = new Map<string, CheckpointTuple>();
  for await (const tuple of checkpointer.list({ configurable: { checkpoint_ns: "" } })) {
    const threadId = tuple.config.configurable?.["thread_id"];
    if (typeof threadId === "string" && !newest.has(threadId)) {
      newest.set(threadId, tuple);
    }
  }
  return [...newest.values()];
}

function isReview(
  pending: PendingRequest,
): pending is PendingRequest & { request: ReviewRequest } {
  return pending.request.kind === REVIEW_REQUEST_KIND;
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
