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

import { STATE_VERSION, THREAD_EXPIRY_DAYS } from "../config/constants.ts";

const MS_PER_DAY = 86_400_000;

export type CheckpointDecision =
  | { action: "resume" }
  | { action: "start-fresh" }
  | { action: "discard"; foundVersion: unknown }
  | { action: "expired"; ageDays: number };

/**
 * Decides what to do with whatever the checkpointer returned for a thread.
 *
 * - nothing checkpointed yet -> start fresh, with no thread to delete;
 * - a `version` this build does not recognise, including a missing one and a
 *   non-object payload -> discard the thread and re-run from the transcript;
 * - a readable checkpoint older than THREAD_EXPIRY_DAYS -> expired, which the
 *   caller drops exactly like a discard but logs as an expiry;
 * - otherwise resume.
 *
 * The version is read before the age because it decides whether the payload
 * means anything at all. `checkpointedAt` comes from the checkpoint tuple's
 * `ts`; omitting it skips the age check.
 */
export function decideCheckpoint(
  loaded: unknown,
  age?: { checkpointedAt: string | undefined; now: Date },
): CheckpointDecision {
  if (loaded === undefined || loaded === null) {
    return { action: "start-fresh" };
  }

  const found = readVersion(loaded);
  if (found !== STATE_VERSION) {
    return { action: "discard", foundVersion: found };
  }

  if (age !== undefined) {
    const ageDays = ageInDays(age.checkpointedAt, age.now);
    if (ageDays > THREAD_EXPIRY_DAYS) {
      return { action: "expired", ageDays };
    }
  }

  return { action: "resume" };
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

/**
 * The checkpoint's age in days. Zero when it carries no timestamp at all, and
 * NaN when the timestamp cannot be parsed — both of which compare false
 * against the expiry, so an age nobody can compute is not treated as stale.
 * The version field is the check that decides whether a payload is readable.
 */
function ageInDays(checkpointedAt: string | undefined, now: Date): number {
  if (checkpointedAt === undefined) {
    return 0;
  }
  return (now.getTime() - Date.parse(checkpointedAt)) / MS_PER_DAY;
}
