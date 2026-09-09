// `signpost review` — answering, in your own terminal, what a run left
// waiting (06-review-and-pr.md, "The review prompt").
//
// This command is the developer's, not the agent's. The background worker
// runs to the interrupt and stops there; showing the prompt is a separate,
// later, interactive-only step, and conflating the two is what would let
// automation answer on the developer's behalf. So it refuses to run when
// stdin is not a terminal — a piped or CI invocation cannot be a person, and
// the answer a non-interactive prompt would collect is nobody's.
//
// Nothing here is a second way to decide. The decisions it collects are the
// same `HumanDecision` records the skill's `resume` sends, keyed the same way
// and validated by the same schema on the way into the graph. What is new is
// only the surface: a list of what is waiting and for how long, one compact
// diff at a time, and a keypress.

import type { ExitCode, Stdio } from "../../app.ts";
import type { ResolvedConfig } from "../../core/config/resolve.ts";
import { OPERATION_TAGS, type HumanDecision } from "../../core/contracts/graph.ts";
import { EXIT_CODES } from "../../core/cli/exit-codes.ts";
import { renderPendingList, type ReviewItem } from "../../core/review/render.ts";
import { resumeRun } from "../../graph/index.ts";
import { promptForReview } from "../../io/review/prompt.ts";
import type { OpenRun, PendingReview, RunHandle } from "../run-port.ts";
import { fail, namedSession, settle, withRun } from "../with-run.ts";

export interface ReviewCommandInput {
  config: ResolvedConfig;
  repoRoot: string;
  openRun: OpenRun;
  stdio: Stdio;
  /** Whether a person is at the other end — `process.stdin.isTTY`, decided at the root. */
  interactive: boolean;
}

const NOT_INTERACTIVE =
  "signpost review is answered by a person at a terminal, and stdin is not one. " +
  "Run it yourself in a shell; a session or a hook must not answer a review.";

const NOTHING = "Nothing is waiting for review.";

export function runReview(input: ReviewCommandInput): Promise<ExitCode> {
  if (!input.interactive) {
    return Promise.resolve(fail(input.stdio.error, NOT_INTERACTIVE));
  }

  return withRun(
    { config: input.config, repoRoot: input.repoRoot, openRun: input.openRun, stderr: input.stdio.error },
    async (handle) => {
      const now = new Date();
      const pending = await handle.pendingReviews(now);
      if (pending.length === 0) {
        input.stdio.output.write(`${NOTHING}\n`);
        return EXIT_CODES.ok;
      }

      input.stdio.output.write(
        `${renderPendingList(
          pending.map((review) => ({
            sessionId: review.sessionId,
            waitingSince: review.waitingSince,
            operations: review.needsHuman.length,
          })),
          now,
        )}\n`,
      );

      for (const review of pending) {
        const quit = await reviewOne(input, handle, review, now);
        if (quit) {
          input.stdio.output.write("Stopped. What you did not answer is still waiting.\n");
          return settled(handle);
        }
      }
      return settled(handle);
    },
  );
}

/**
 * What answering a review reports to whatever ran it.
 *
 * The exit code table is the CLI's, not `run`'s (12-wire-contracts.md, "Exit
 * codes"): answering the last review in the terminal is as often as not the
 * invocation that reaches `commit`, so it is also the one that can push a
 * branch and fail to open its pull request. Reporting 0 for that would tell a
 * wrapper the work is on the forge when it is not.
 */
function settled(handle: RunHandle): ExitCode {
  return handle.prNotOpened() === null ? EXIT_CODES.ok : EXIT_CODES.prCreationFailed;
}

/**
 * One halted thread: shown, answered, and resumed with whatever was decided.
 *
 * Skipped operations are simply absent from the decisions, which is what
 * leaves the thread halted on exactly them — `human_review` re-enters its
 * loop and asks again next time (src/core/graph/decisions.ts). Nothing is
 * resumed at all when nothing was decided: `resumeRun` refuses an empty set
 * of answers, and rightly, since there is nothing for the thread to do with
 * them.
 */
async function reviewOne(
  input: ReviewCommandInput,
  handle: RunHandle,
  review: PendingReview,
  now: Date,
): Promise<boolean> {
  const items = await Promise.all(
    review.needsHuman.map(async ({ operation, reason }) => toItem(handle, operation, reason)),
  );

  const { decisions, quit } = await promptForReview({ items, io: input.stdio, now });

  if (Object.keys(decisions).length > 0) {
    await apply(input, handle, review, decisions, now);
  }
  return quit;
}

async function toItem(
  handle: RunHandle,
  operation: ReviewItem["operation"],
  reason: ReviewItem["reason"],
): Promise<ReviewItem> {
  // The "before" half of the diff, read now rather than remembered from the
  // run that halted: the operation was proposed against what the repo said
  // then, and the reviewer is deciding against what it says today.
  const before =
    operation.op === OPERATION_TAGS.add
      ? undefined
      : await handle.index.byId(handle.repo, operation.id);
  return { operation, reason, ...(before === undefined ? {} : { before }) };
}

/** Resumes the thread with the decisions, and says where that left the session. */
async function apply(
  input: ReviewCommandInput,
  handle: RunHandle,
  review: PendingReview,
  decisions: Record<string, HumanDecision>,
  now: Date,
): Promise<void> {
  const result = await resumeRun(
    handle.graph,
    handle.checkpointer,
    { repo: handle.repo, sessionId: review.sessionId, contentHash: review.contentHash },
    { [review.interruptId]: decisions },
  );

  await settle({
    handle,
    session: namedSession(handle, review.sessionId, review.contentHash, now),
    result,
    statusPath: input.config.paths.statuslineState,
    now,
    // `review` answers a halt, so it continues a run rather than opening one.
    isFirst: false,
  });

  input.stdio.output.write(
    result.pending.length === 0
      ? `session ${review.sessionId}: done — ${String(result.state.operations.length)} operation(s) committed to the branch.\n`
      : `session ${review.sessionId}: still waiting on ${String(result.pending.length)} more.\n`,
  );
}
