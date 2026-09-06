// Starting and resuming one extraction run.
//
// A run halts whenever it needs something only the session outside it can
// give: an answer from the model (src/graph/host-model.ts) or a decision from
// a person (nodes/human-review.ts). Both are `interrupt()`s, both come back
// here as pending requests, and both are answered the same way — by interrupt
// id, through `resumeRun`. A run therefore proceeds in halts: start, answer
// what came back, resume, repeat until nothing is pending.
//
// This is also where the thread id and the state version meet the
// checkpointer. Both exist for the same reason: an answer may arrive three
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
//
//   - The checkpoint's age decides whether it is still worth resuming. Three
//     days is the case this is built for; three months is not. Past
//     THREAD_EXPIRY_DAYS the thread is dropped with a log line, because its
//     partition was computed against neighbours, ids and a bootstrap flag the
//     repo has long since moved past.

import { Command, INTERRUPT, isInterrupted } from "@langchain/langgraph";
import type { BaseCheckpointSaver, LangGraphRunnableConfig } from "@langchain/langgraph";
import { STATE_VERSION, THREAD_EXPIRY_DAYS } from "../core/config/constants.ts";
import { buildThreadId, type ThreadIdParts } from "../core/graph/thread-id.ts";
import { decideCheckpoint, type CheckpointDecision } from "../core/graph/state-version.ts";
import type { ExtractionGraph } from "./graph.ts";
import type { GraphPorts } from "./ports.ts";
import type { ExtractionState } from "./state.ts";
import type { ModelRequest } from "./host-model.ts";
import type { ReviewRequest } from "./nodes/human-review.ts";

export interface RunInput extends ThreadIdParts {
  repoRoot: string;
  /** Path to the raw transcript. Re-read by `gutter` and again by `extract`. */
  transcriptPath: string;
}

/** What a halted run is waiting for, and the id its answer is filed under. */
export interface PendingRequest {
  /**
   * LangGraph's interrupt id. Answers are keyed by it rather than by position
   * because `classify` fans out: several tasks can be halted at once, and a
   * positional answer would hand one candidate's classification to another.
   */
  id: string;
  request: ModelRequest | ReviewRequest;
}

/** One answer per pending request, keyed by `PendingRequest.id`. */
export type Replies = Record<string, unknown>;

export interface RunResult {
  threadId: string;
  /** Whether the checkpoint was resumed, started clean, or thrown away first. */
  disposition: "resumed" | "fresh" | "discarded";
  state: ExtractionState;
  /**
   * Empty when the run finished. Otherwise what it halted on: answer every
   * entry and hand the lot back to `resumeRun`.
   */
  pending: PendingRequest[];
}

/**
 * What the run halted on, read off the value `invoke` returned.
 *
 * An interrupt with no id throws rather than being dropped. A dropped one
 * would arrive at the caller as an empty `pending`, which is indistinguishable
 * from a finished run — the session would be recorded as processed and the
 * thread left parked at a halt nothing ever returns to.
 */
function pendingOf(state: ExtractionState): PendingRequest[] {
  if (!isInterrupted(state)) {
    return [];
  }
  return state[INTERRUPT].map((interrupted) => {
    if (interrupted.id === undefined) {
      throw new Error(
        "a run halted on an interrupt with no id, so there is no key to answer it under",
      );
    }
    return { id: interrupted.id, request: interrupted.value as ModelRequest | ReviewRequest };
  });
}

/**
 * What the thread is halted on right now, according to its checkpoint.
 *
 * An interrupt with no id throws here for the same reason it does in
 * `pendingOf`, and doubly so: this list is the allow-list a resume's keys are
 * checked against. Dropping one silently would reject a caller answering the
 * halt it was told about with "it is waiting on nothing", pointing at the
 * caller rather than at the malformed checkpoint.
 */
async function pendingOnThread(
  graph: ExtractionGraph,
  config: LangGraphRunnableConfig,
): Promise<PendingRequest[]> {
  const snapshot = await graph.getState(config);
  return snapshot.tasks.flatMap((task) =>
    task.interrupts.map((interrupted) => {
      if (interrupted.id === undefined) {
        throw new Error(
          "a thread is halted on an interrupt with no id, so there is no key to answer it under",
        );
      }
      return { id: interrupted.id, request: interrupted.value as ModelRequest | ReviewRequest };
    }),
  );
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

  const decision = await load(checkpointer, config);

  if (decision.action === "expired") {
    console.warn(
      `Checkpointed review for thread ${threadId} is ` +
        `${decision.ageDays.toFixed(0)} days old (expiry ${String(THREAD_EXPIRY_DAYS)} days). ` +
        "Dropping it and extracting again.",
    );
  }

  if (decision.action === "discard" || decision.action === "expired") {
    // Thrown away rather than migrated. Re-running costs one file read and a
    // deterministic reduction, because no guttered text was ever checkpointed.
    await checkpointer.deleteThread(threadId);
    const state = await graph.invoke(initialState(input), config);
    return { threadId, disposition: "discarded", state, pending: pendingOf(state) };
  }

  if (decision.action === "resume") {
    // `null` continues the existing thread from its last checkpoint rather
    // than seeding it again — re-sending the input would replay `extract`.
    const state = await graph.invoke(null, config);
    return { threadId, disposition: "resumed", state, pending: pendingOf(state) };
  }

  const state = await graph.invoke(initialState(input), config);
  return { threadId, disposition: "fresh", state, pending: pendingOf(state) };
}

/** The checkpoint for a thread, judged on both its version and its age. */
async function load(
  checkpointer: BaseCheckpointSaver,
  config: LangGraphRunnableConfig,
): Promise<CheckpointDecision> {
  const tuple = await checkpointer.getTuple(config);
  return decideCheckpoint(tuple?.checkpoint.channel_values, {
    checkpointedAt: tuple?.checkpoint.ts,
    now: new Date(),
  });
}

/**
 * Answers what a halted run asked for and lets it carry on.
 *
 * `replies` is keyed by `PendingRequest.id`; a model answer and a review
 * decision travel the same way, because to the graph they are the same thing —
 * a value an `interrupt()` returns. Answering only some of them is allowed and
 * ordinary: the run halts again on the rest.
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
 * A thread past THREAD_EXPIRY_DAYS throws here for the same reason, rather
 * than being silently dropped as it is in `startRun`: the caller is holding
 * answers to a review, and starting a fresh run behind their back would
 * pretend those answers were applied.
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
  replies: Replies,
): Promise<RunResult> {
  const threadId = buildThreadId(parts);
  const config = threadConfigFor(threadId);

  const decision = await load(checkpointer, config);
  if (decision.action === "expired") {
    throw new Error(
      `resumeRun: thread ${threadId} expired ` +
        `(${decision.ageDays.toFixed(0)} days old, expiry ${String(THREAD_EXPIRY_DAYS)} days). ` +
        "Re-run the extraction and review it again.",
    );
  }
  if (decision.action !== "resume") {
    throw new Error(
      `resumeRun: thread ${threadId} cannot be resumed by this build ` +
        `(state version ${String(STATE_VERSION)}, checkpoint ` +
        `${decision.action === "discard" ? String(decision.foundVersion) : "absent"}). ` +
        "Re-run the extraction and review it again.",
    );
  }

  if (Object.keys(replies).length === 0) {
    throw new Error(`resumeRun: thread ${threadId} was given no answers to resume with.`);
  }

  // Every key has to name a halt this thread is actually waiting on. The map
  // form of `resume` is only recognised when *every* key is an interrupt id
  // (LangGraph tests them against /^[0-9a-f]{32}$/); one key that is not — a
  // node name, a truncated id, an id from an earlier halt — silently demotes
  // the whole object to the bare form, which hands all of it to every halted
  // task as that task's answer. Checking the keys here is what makes the
  // "answers are keyed by id" contract true rather than merely intended.
  const pending = await pendingOnThread(graph, config);
  const answerable = new Set(pending.map((request) => request.id));
  const unknown = Object.keys(replies).filter((id) => !answerable.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `resumeRun: thread ${threadId} is not waiting on ${unknown.join(", ")} — ` +
        `it is waiting on ${pending.length === 0 ? "nothing" : [...answerable].join(", ")}`,
    );
  }

  // The map form of `resume`, not the bare value: LangGraph routes a bare
  // value to whichever task consumes it first, which with a fan-out halted on
  // several classify tasks means every one of them gets the same answer.
  const state = await graph.invoke(new Command({ resume: replies }), config);
  return { threadId, disposition: "resumed", state, pending: pendingOf(state) };
}
