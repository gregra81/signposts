// What the terminal review prompt puts on screen: the listing of what is
// waiting, and one operation as a before/after diff with the reason it was
// held (06-review-and-pr.md, "The review prompt").
//
// Compact on purpose. The reviewer is being asked one question — does this
// claim belong in the repo — and the PR is where the full text lives. So a
// header naming what the operation does and to what, the claim before and
// after, and the evidence line that is the answer to "why does it think
// this?".
//
// PURE: operations in, text out. Nothing here reads a clock; `formatWaited`
// takes both ends of the interval as arguments.

import {
  GATE_REASONS,
  OPERATION_TAGS,
  type GateReason,
  type Operation,
} from "../contracts/graph.ts";
import type { Signpost } from "../signpost/schema.ts";

/** One gated operation, with whatever it acts on as it stands today. */
export interface ReviewItem {
  operation: Operation;
  reason: GateReason;
  /**
   * What the targeted signpost currently says — the "before" half. Absent for
   * an `add`, and absent when the target is a proposal an earlier session in
   * this same run made and nobody has accepted (`pending_neighbour`): there is
   * no recorded claim to show yet.
   */
  before?: Signpost;
}

/** Why this one stopped, in the words the person deciding it needs. */
const REASON_TEXT: Record<GateReason, string> = {
  [GATE_REASONS.low_confidence]: "the model was not confident",
  [GATE_REASONS.edits_existing]: "it changes a signpost you already have",
  [GATE_REASONS.deletes_existing]: "it removes a signpost you already have",
  [GATE_REASONS.unresolved_contradiction]:
    "it contradicts what is recorded and nothing could settle which is right",
  [GATE_REASONS.bootstrap_run]: "this repo's first run, so everything is reviewed",
  [GATE_REASONS.pending_neighbour]: "it targets a proposal you have not accepted yet",
};

const REMOVED = "-";
const ADDED = "+";
const UNCHANGED = "=";

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/** The id an operation acts on: what it would create, or what it targets. */
export function targetId(operation: Operation): string {
  return operation.op === OPERATION_TAGS.add ? operation.signpost.id : operation.id;
}

/**
 * One operation as the reviewer sees it.
 *
 * Which lines a diff has is decided per operation, not by which fields happen
 * to be filled in. A `reinforce` and a scope-only `refine` both leave the
 * claim exactly as it is, so both show it once with `=`: printing the current
 * claim under a `-` would say the operation removes it, which is the opposite
 * of what it does.
 */
export function renderItem(item: ReviewItem): string {
  const { operation } = item;
  const lines = [
    `${operation.op} ${targetId(operation)} — ${REASON_TEXT[item.reason]}`,
    ...diffLines(operation, item.before?.claim),
  ];

  if (operation.op === OPERATION_TAGS.refine && operation.scope !== undefined) {
    lines.push(`  scope: ${JSON.stringify(operation.scope)}`);
  }

  const why = whyText(operation);
  if (why !== undefined) {
    lines.push(`  why: ${why}`);
  }
  return lines.join("\n");
}

/**
 * The claim, before and after.
 *
 * `before` is absent for an `add`, and absent for the rest when the target is
 * a proposal an earlier session in this run made and nobody has accepted yet
 * — there is no recorded claim to show. The after line stands alone then,
 * rather than the whole operation being unprintable.
 */
function diffLines(operation: Operation, before: string | undefined): string[] {
  const kept = before === undefined ? undefined : `${UNCHANGED} ${before}`;

  switch (operation.op) {
    case OPERATION_TAGS.add:
      return [`${ADDED} ${operation.signpost.claim}`];
    case OPERATION_TAGS.reinforce:
      return [kept ?? `${UNCHANGED} ${unchangedText(operation)}`];
    case OPERATION_TAGS.retire:
      return [before === undefined ? `${REMOVED} ${unchangedText(operation)}` : `${REMOVED} ${before}`];
    default: {
      // refine and supersede. A refine with no claim changes only the scope,
      // so the claim it leaves alone is shown as kept.
      const after =
        operation.op === OPERATION_TAGS.supersede ? operation.replacement.claim : operation.claim;
      if (after === undefined) {
        return [kept ?? `${UNCHANGED} ${unchangedText(operation)}`];
      }
      return before === undefined
        ? [`${ADDED} ${after}`]
        : [`${REMOVED} ${before}`, `${ADDED} ${after}`];
    }
  }
}

/** What an operation that rewrites no claim is doing instead. */
function unchangedText(operation: Operation): string {
  return operation.op === OPERATION_TAGS.reinforce
    ? "another session said the same thing"
    : operation.op === OPERATION_TAGS.retire
      ? "removes this signpost"
      : "narrows the scope, leaving the claim as it is";
}

/** The evidence for the change, which is the whole case for accepting it. */
function whyText(operation: Operation): string | undefined {
  switch (operation.op) {
    case OPERATION_TAGS.add:
      return operation.signpost.evidence;
    case OPERATION_TAGS.supersede:
      return operation.replacement.evidence;
    case OPERATION_TAGS.refine:
      return operation.evidence;
    case OPERATION_TAGS.retire:
      return operation.reason;
    case OPERATION_TAGS.reinforce:
      // Provenance only: nothing was claimed, so there is nothing to justify.
      return undefined;
  }
}

/** One line of the "what is waiting" listing. */
export interface PendingSummary {
  sessionId: string;
  waitingSince: Date;
  operations: number;
}

/**
 * How long a halt has been sitting there, coarsely: hours under a day, days
 * above it. A review left for six weeks is about to be dropped, and "42 days"
 * is what says so.
 */
export function formatWaited(waitingSince: Date, now: Date): string {
  const elapsed = now.getTime() - waitingSince.getTime();
  if (elapsed < MS_PER_DAY) {
    return plural(Math.max(Math.floor(elapsed / MS_PER_HOUR), 0), "hour");
  }
  return plural(Math.floor(elapsed / MS_PER_DAY), "day");
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

/** The listing `signpost review` opens with. */
export function renderPendingList(pending: readonly PendingSummary[], now: Date): string {
  if (pending.length === 0) {
    return "Nothing is waiting for review.";
  }
  const lines = pending.map(
    (entry, position) =>
      `  ${String(position + 1)}. session ${entry.sessionId} — ` +
      `${plural(entry.operations, "operation")}, waiting ${formatWaited(entry.waitingSince, now)}`,
  );
  return [`${plural(pending.length, "session")} waiting for review:`, ...lines].join("\n");
}
