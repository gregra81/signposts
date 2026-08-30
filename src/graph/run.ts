// Starting and resuming one extraction run.
//
// This is where the thread id and the state version meet the checkpointer.
// Both exist for the same reason: a human may answer `human_review` three
// days later, from a process that never saw this one.
//
//   - The thread id is *computed*, never remembered
//     (src/core/graph/thread-id.ts). `signpost resume` rebuilds it from the
//     repo, the session and the transcript's content hash — all of which are
//     on disk — so nothing has to survive in memory across the gap.
//
//   - The version on the loaded checkpoint decides whether that thread can be
//     resumed at all (src/core/graph/state-version.ts). An unrecognised
//     version is discarded and the run starts again from the transcript,
//     rather than resuming into a shape this build no longer understands.

import { Command } from "@langchain/langgraph";
import type { BaseCheckpointSaver, LangGraphRunnableConfig } from "@langchain/langgraph";
import { STATE_VERSION } from "../core/config/constants.ts";
import { buildThreadId, type ThreadIdParts } from "../core/graph/thread-id.ts";
import { decideCheckpoint } from "../core/graph/state-version.ts";
import type { ExtractionGraph } from "./graph.ts";
import type { ExtractionState } from "./state.ts";
import type { ReviewResponse } from "./nodes/human-review.ts";

export interface RunInput extends ThreadIdParts {
  repoRoot: string;
  /** Path to the raw transcript. Re-read by `gutter` and again by `extract`. */
  transcriptPath: string;
}

export interface RunResult {
  threadId: string;
  /** Whether the checkpoint was resumed, started clean, or thrown away first. */
  disposition: "resumed" | "fresh" | "discarded";
  state: ExtractionState;
}

export function threadConfigFor(threadId: string): LangGraphRunnableConfig {
  return { configurable: { thread_id: threadId } };
}

/**
 * The initial state for a clean run.
 *
 * `version` is written explicitly rather than left to the channel default:
 * only channels a node has actually written appear in a checkpoint, and a
 * version that is merely defaulted would be absent from the payload the next
 * process loads — which reads as "unrecognised" and discards a healthy
 * thread. Writing it here is what makes the version check mean anything.
 */
export function initialState(input: RunInput): Partial<ExtractionState> {
  return {
    version: STATE_VERSION,
    sessionId: input.sessionId,
    repo: input.repo,
    repoRoot: input.repoRoot,
    contentHash: input.contentHash,
    transcriptPath: input.transcriptPath,
  };
}

/**
 * Runs the graph for one transcript, resuming an existing thread where the
 * checkpoint is one this build understands.
 *
 * A run that reaches `human_review` returns here with the interrupt pending;
 * the state it returns is the halted state, and `resumeRun` continues it
 * later — possibly days later, from a different process.
 */
export async function startRun(
  graph: ExtractionGraph,
  checkpointer: BaseCheckpointSaver,
  input: RunInput,
): Promise<RunResult> {
  const threadId = buildThreadId(input);
  const config = threadConfigFor(threadId);

  const tuple = await checkpointer.getTuple(config);
  const decision = decideCheckpoint(tuple?.checkpoint.channel_values);

  if (decision.action === "discard") {
    // Thrown away rather than migrated. Re-running costs one file read and a
    // deterministic reduction, because no guttered text was ever checkpointed.
    await checkpointer.deleteThread(threadId);
    const state = await graph.invoke(initialState(input), config);
    return { threadId, disposition: "discarded", state };
  }

  if (decision.action === "resume") {
    // `null` continues the existing thread from its last checkpoint rather
    // than seeding it again — re-sending the input would replay `extract`.
    const state = await graph.invoke(null, config);
    return { threadId, disposition: "resumed", state };
  }

  const state = await graph.invoke(initialState(input), config);
  return { threadId, disposition: "fresh", state };
}

/**
 * Answers a halted `human_review` and lets the run finish.
 *
 * The thread id is rebuilt from the same three values that produced it, not
 * carried over from the run that halted — that is the property that makes a
 * three-day gap survivable.
 *
 * The same gap is why the version check runs here too. This is the path the
 * check exists for: a resume days later, from another process, after an
 * upgrade. `startRun` guarded it and this did not, so bumping STATE_VERSION
 * would have shipped a build that refused stale threads on the way in and
 * resumed them anyway on the way back.
 *
 * A thread this build cannot resume throws rather than starting fresh. The
 * caller is holding decisions a person made against a partition from a shape
 * that no longer applies; re-running silently would discard their review, and
 * applying it to a rebuilt partition would attach their answers to operations
 * they never saw.
 */
export async function resumeRun(
  graph: ExtractionGraph,
  checkpointer: BaseCheckpointSaver,
  parts: ThreadIdParts,
  decisions: ReviewResponse,
): Promise<RunResult> {
  const threadId = buildThreadId(parts);
  const config = threadConfigFor(threadId);

  const tuple = await checkpointer.getTuple(config);
  const decision = decideCheckpoint(tuple?.checkpoint.channel_values);
  if (decision.action !== "resume") {
    throw new Error(
      `resumeRun: thread ${threadId} cannot be resumed by this build ` +
        `(state version ${String(STATE_VERSION)}, checkpoint ` +
        `${decision.action === "discard" ? String(decision.foundVersion) : "absent"}). ` +
        "Re-run the extraction and review it again.",
    );
  }

  const state = await graph.invoke(new Command({ resume: decisions }), config);
  return { threadId, disposition: "resumed", state };
}
