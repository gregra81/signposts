// The load-time gate on a checkpoint (12-wire-contracts.md's GraphState:
// "version: 1; bump on shape change; unrecognised => discard thread").
//
// The rule this encodes: a checkpoint whose version this build does not
// recognise is DISCARDED and the run starts again from the transcript. It is
// never resumed. Resuming into a shape the code no longer understands is the
// failure mode worth spending a version field to avoid — the state would
// deserialise into fields that are silently absent or wrong-typed, and the
// first node to touch one would produce nonsense rather than an error.
//
// Discarding is cheap precisely because of what state does NOT hold: no
// guttered text, so re-running means re-reading a file and re-running a
// deterministic reduction. The only real cost is the LLM calls already made,
// which a shape change has probably invalidated anyway.
//
// The check is on `version` and nothing else. Validating the whole payload
// against graphStateSchema here would be worse than useless: a checkpoint
// only carries the channels that have actually been written, so a thread
// interrupted at `human_review` legitimately has no `resolutions` key, and a
// full-shape parse would discard a healthy thread as malformed. The version
// field IS the compatibility contract — that is what it is for.
//
// PURE: takes the already-loaded checkpoint value, returns a decision. Reading
// it, and acting on a "discard" by deleting the thread, are the caller's job.

import { STATE_VERSION } from "../config/constants.ts";

export type CheckpointDecision =
  | { action: "resume" }
  | { action: "start-fresh" }
  | { action: "discard"; foundVersion: unknown };

/**
 * Decides what to do with whatever the checkpointer returned for a thread.
 *
 * - nothing checkpointed yet -> start fresh, with no thread to delete;
 * - `version` equals STATE_VERSION -> resume;
 * - anything else, including a missing `version` and a non-object payload ->
 *   discard the thread and re-run from the transcript.
 */
export function decideCheckpoint(loaded: unknown): CheckpointDecision {
  if (loaded === undefined || loaded === null) {
    return { action: "start-fresh" };
  }

  const found = readVersion(loaded);
  return found === STATE_VERSION ? { action: "resume" } : { action: "discard", foundVersion: found };
}

/**
 * The `version` field, or undefined for anything that cannot carry one.
 *
 * No typeof guard: `loaded` is neither null nor undefined by the time this is
 * called, and reading a missing property off a string, a number or a boolean
 * is already `undefined`. A guard here would be unreachable by any input.
 */
function readVersion(loaded: unknown): unknown {
  return (loaded as { version?: unknown }).version;
}
