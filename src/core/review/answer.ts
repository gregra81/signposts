// What the reviewer typed, and what an edit does to the operation it answers.
//
// Five answers, and they are not five variations on the same thing:
//
//   accept — commit it as proposed.
//   reject — drop it. A decision, recorded as one, so it never comes back.
//   edit   — commit different wording. The target never changes; see below.
//   skip   — decide later. No decision is recorded, so `isReviewComplete`
//            leaves the thread halted and the next `signpost review` asks
//            again (src/core/graph/decisions.ts).
//   quit   — stop reviewing. Same as skipping the rest.
//
// Reject and skip are the pair worth keeping apart. Both stop the operation
// reaching `commit` today; only reject stops it being asked about tomorrow.
//
// PURE.

import { OPERATION_TAGS, type Operation } from "../contracts/graph.ts";

export const REVIEW_CHOICES = {
  accept: "accept",
  reject: "reject",
  edit: "edit",
  skip: "skip",
  quit: "quit",
} as const;

export type ReviewChoice = (typeof REVIEW_CHOICES)[keyof typeof REVIEW_CHOICES];

/** Whole words, so `accept` and `a` both work. */
const WORDS = new Set<string>(Object.values(REVIEW_CHOICES));

/**
 * First letter to choice, in the order the prompt lists them.
 *
 * A Map rather than an object literal, because the lookup key is whatever was
 * typed: `BY_KEY["constructor"]` on an object reaches through the prototype
 * and hands back the `Object` function, so a function whose type says
 * `ReviewChoice | undefined` would return something that is neither.
 */
const BY_KEY = new Map<string, ReviewChoice>([
  ["a", REVIEW_CHOICES.accept],
  ["r", REVIEW_CHOICES.reject],
  ["e", REVIEW_CHOICES.edit],
  ["s", REVIEW_CHOICES.skip],
  ["q", REVIEW_CHOICES.quit],
]);

/**
 * The choice the typed line names, or undefined when it names none.
 *
 * Undefined for the empty line too. There is no default answer here: every
 * other prompt in this tool can afford one (consent reads a bare Enter as
 * "no"), but a reviewer leaning on Enter through a list of proposals would be
 * silently choosing for each of them, and both plausible defaults are wrong —
 * accepting is a merge nobody read, skipping is a queue that never empties.
 *
 * `editable` is false for the operations with no text of their own to change:
 * a `reinforce` only records provenance, and a `retire` names what it removes.
 * Offering `edit` there would ask the reviewer to rewrite a claim the
 * operation does not carry.
 */
export function parseReviewChoice(line: string, editable: boolean): ReviewChoice | undefined {
  const typed = line.trim().toLowerCase();
  const choice = BY_KEY.get(typed) ?? (WORDS.has(typed) ? (typed as ReviewChoice) : undefined);
  // An unknown word is already undefined, so only the edit rule needs saying.
  return choice === REVIEW_CHOICES.edit && !editable ? undefined : choice;
}

/** Whether this operation carries wording a reviewer could change. */
export function isEditable(operation: Operation): boolean {
  return (
    operation.op === OPERATION_TAGS.add ||
    operation.op === OPERATION_TAGS.supersede ||
    operation.op === OPERATION_TAGS.refine
  );
}

/** The claim and evidence an edit starts from — what the prompt shows as the current text. */
export function editableText(operation: Operation): { claim?: string; evidence?: string } {
  switch (operation.op) {
    case OPERATION_TAGS.add:
      return { claim: operation.signpost.claim, evidence: operation.signpost.evidence };
    case OPERATION_TAGS.supersede:
      return { claim: operation.replacement.claim, evidence: operation.replacement.evidence };
    case OPERATION_TAGS.refine:
      return {
        ...(operation.claim === undefined ? {} : { claim: operation.claim }),
        ...(operation.evidence === undefined ? {} : { evidence: operation.evidence }),
      };
    default:
      return {};
  }
}

export interface Edits {
  claim?: string;
  evidence?: string;
}

/**
 * The operation as the reviewer's wording leaves it.
 *
 * An absent field means "leave that one alone", so a reviewer who retypes the
 * claim and presses Enter through the evidence keeps the evidence. What can
 * never change is what the operation acts on: 06-review-and-pr.md's prompt
 * names the signpost in its header and offers `[e]dit` on the text, so the
 * reviewer chooses wording, not a target — and `retargetedEdits` rejects the
 * decision if anything here ever broke that.
 */
export function withEdits(operation: Operation, edits: Edits): Operation {
  switch (operation.op) {
    case OPERATION_TAGS.add:
      return { ...operation, signpost: { ...operation.signpost, ...defined(edits) } };
    case OPERATION_TAGS.supersede:
      return { ...operation, replacement: { ...operation.replacement, ...defined(edits) } };
    case OPERATION_TAGS.refine:
      return { ...operation, ...defined(edits) };
    default:
      return operation;
  }
}

function defined(edits: Edits): Edits {
  return {
    ...(edits.claim === undefined ? {} : { claim: edits.claim }),
    ...(edits.evidence === undefined ? {} : { evidence: edits.evidence }),
  };
}
