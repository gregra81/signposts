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
// past THREAD_EXPIRY_DAYS is dropped here and said so — by `signpost review`
// only, see `dropExpired` — for the reason
// 04-extraction-graph.md gives — its partition was computed against
// neighbours, ids and a bootstrap flag the repo has long since moved past, so
// there is nothing honest left to review.

import type {
  BaseCheckpointSaver,
  CheckpointTuple,
  LangGraphRunnableConfig,
} from "@langchain/langgraph";
import type { PendingReview } from "../../cli/run-port.ts";
import { THREAD_EXPIRY_DAYS } from "../../core/config/constants.ts";
import { decideCheckpoint } from "../../core/graph/state-version.ts";
import { reviewExpiresAt } from "../../core/review/expiry.ts";
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
  /** See PendingReviewsOptions in ../../cli/run-port.ts. Off unless a person is reading. */
  dropExpired?: boolean;
}

/** What a checkpoint carries about the session it belongs to. */
interface ThreadIdentity {
  repo: string;
  sessionId: string;
  contentHash: string;
}

export async function listPendingReviews(input: PendingReviewsInput): Promise<PendingReview[]> {
  const reviews: PendingReview[] = [];

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

    // Whether it is holding a review is asked BEFORE the expiry is acted on.
    // `decideCheckpoint` reads a version and a timestamp; it has no idea
    // whether anyone is waiting. Nothing deletes a thread when its run reaches
    // `commit`, so the database keeps the last checkpoint of every finished
    // run — and judged on age alone, each of those printed "Dropping it" at a
    // developer who was told their pending reviews had been thrown away.
    const halts = (await pendingOnThread(input.graph, threadConfigFor(threadId))).filter(isReview);
    if (halts.length === 0) {
      continue;
    }

    if (decision.action === "expired") {
      if (input.dropExpired !== true) {
        // Not listed — `resumeRun` would refuse it — and not deleted: whoever
        // is reading this has nobody to tell. The developer's own `signpost
        // review` drops it, in front of them, after the status line and the
        // session-start notice have spent a week saying it was coming.
        continue;
      }
      input.warn(
        `Pending review for thread ${threadId} is ${decision.ageDays.toFixed(0)} days old ` +
          `(expiry ${String(THREAD_EXPIRY_DAYS)} days). Dropping it.`,
      );
      await input.checkpointer.deleteThread(threadId);
      continue;
    }

    for (const halt of halts) {
      reviews.push({
        threadId,
        sessionId: identity.sessionId,
        contentHash: identity.contentHash,
        interruptId: halt.id,
        waitingSince: new Date(tuple.checkpoint.ts),
        expiresAt: reviewExpiresAt(new Date(tuple.checkpoint.ts)),
        needsHuman: halt.request.needsHuman,
      });
    }
  }

  // Longest-waiting first: the one most likely to be forgotten is the one the
  // developer is shown first.
  return reviews.sort((left, right) => left.waitingSince.getTime() - right.waitingSince.getTime());
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
