// Node 7, `validate` (04-extraction-graph.md): deterministic schema-lint over
// the proposed operations. No LLM, no IO.
//
// The doc's checklist, in order: "claim is a single sentence within length
// limits, category valid, supersede/retire reference real ids, no operation
// targets a signpost twice, scope globs parse."
//
// The first two are already the operation schema's job (claimSchema and
// categorySchema, in ../signpost/schema.ts) so they are checked by parsing
// rather than restated here. The last three are cross-cutting — they depend
// on what is already in the repo, or on the batch as a whole — so they live
// here.
//
// The id check is applied to every operation that names an existing signpost,
// not only supersede and retire. `refine` edits one and `reinforce` appends
// provenance to one; both are just as broken pointing at an id that is not
// there, and the doc's phrasing names the destructive pair rather than
// excluding the others.
//
// Errors are returned per candidate, not per operation, because that is the
// unit the run drops: a candidate that produced a bad operation is removed
// whole, so a partially-applied candidate can never reach `commit`.

import { summariseIssues } from "../errors/format-zod-error.ts";
import {
  OPERATION_TAGS,
  operationSchema,
  type CandidateOperations,
  type Operation,
} from "../contracts/graph.ts";

export interface ValidateInput {
  built: readonly CandidateOperations[];
  /** Signpost ids that actually exist in this repo. */
  existingIds: ReadonlySet<string>;
}

export interface ValidateResult {
  /** Candidates whose every operation passed. Ready for the gate. */
  valid: CandidateOperations[];
  /** One human-readable line per failure, fed back to `extract` on a retry. */
  errors: string[];
}

export function validateOperations({ built, existingIds }: ValidateInput): ValidateResult {
  const valid: CandidateOperations[] = [];
  const errors: string[] = [];

  // "No operation targets a signpost twice" is a property of the whole batch,
  // so targets accumulate across candidates as they are accepted. A candidate
  // that fails for another reason never reserves its targets — otherwise a
  // dropped candidate would take a valid later one down with it.
  const claimedTargets = new Set<string>();

  for (const candidate of built) {
    const { errors: candidateErrors, targets } = checkCandidate(
      candidate,
      existingIds,
      claimedTargets,
    );
    if (candidateErrors.length > 0) {
      errors.push(...candidateErrors);
      continue;
    }
    for (const target of targets) {
      claimedTargets.add(target);
    }
    valid.push(candidate);
  }

  return { valid, errors };
}

/**
 * One candidate's errors, plus the ids it targets.
 *
 * The targets are returned rather than recomputed by the caller: a second walk
 * over the same operations was not only duplicated work, it was unobservable —
 * whether it filtered out the `add` operations or not, the result went into a
 * Set that is only ever queried with a defined id, so getting the filter wrong
 * changed nothing. Returning the set the checks already built removes the
 * second definition of "what this candidate targets".
 */
function checkCandidate(
  candidate: CandidateOperations,
  existingIds: ReadonlySet<string>,
  claimedTargets: ReadonlySet<string>,
): { errors: string[]; targets: ReadonlySet<string> } {
  const errors: string[] = [];
  // Targets claimed by an earlier operation of this same candidate, so a
  // candidate that somehow targets one signpost twice is caught too.
  const seenHere = new Set<string>();

  for (const operation of candidate.operations) {
    const parsed = operationSchema.safeParse(operation);
    if (!parsed.success) {
      // Labelled by candidate and not by `operation.op`: a value malformed
      // enough to fail this parse may not have an `op` at all, and
      // "undefined failed schema validation" is a worse message than none.
      // The issue path names the field anyway.
      errors.push(
        `${candidate.tempId}: operation failed schema validation: ${summariseIssues(parsed.error.issues)}`,
      );
      continue;
    }

    const target = targetOf(operation);
    if (target !== undefined) {
      if (!existingIds.has(target)) {
        errors.push(`${candidate.tempId}: ${operation.op} references unknown signpost id "${target}"`);
      }
      if (claimedTargets.has(target) || seenHere.has(target)) {
        errors.push(`${candidate.tempId}: ${operation.op} targets signpost "${target}" a second time`);
      }
      seenHere.add(target);
    }

    errors.push(...scopeErrors(candidate.tempId, operation));
  }

  return { errors, targets: seenHere };
}

/** The existing signpost an operation acts on, or undefined for a pure `add`. */
function targetOf(operation: Operation): string | undefined {
  return operation.op === OPERATION_TAGS.add ? undefined : operation.id;
}

function scopeErrors(tempId: string, operation: Operation): string[] {
  const scope =
    operation.op === OPERATION_TAGS.add
      ? operation.signpost.scope
      : operation.op === OPERATION_TAGS.supersede
        ? operation.replacement.scope
        : operation.op === OPERATION_TAGS.refine
          ? operation.scope
          : undefined;

  const paths = scope?.paths;
  if (paths === undefined) {
    return [];
  }

  return paths
    .filter((glob) => !isParseableGlob(glob))
    .map((glob) => `${tempId}: ${operation.op} has an unparseable scope glob ${JSON.stringify(glob)}`);
}

/**
 * Whether a scope path is a glob this codebase can hand to a matcher.
 *
 * Deliberately structural rather than a full glob grammar: an empty pattern,
 * and unbalanced `[...]` or `{...}`, are the failures a model actually
 * produces, and they are the ones that make a matcher either throw or match
 * nothing at all. Anything else is left to the matcher.
 */
export function isParseableGlob(glob: string): boolean {
  if (glob.length === 0) {
    return false;
  }
  return isBalanced(glob, "[", "]") && isBalanced(glob, "{", "}");
}

function isBalanced(text: string, open: string, close: string): boolean {
  let depth = 0;
  for (const character of text) {
    if (character === open) {
      depth += 1;
    } else if (character === close) {
      depth -= 1;
      if (depth < 0) {
        return false;
      }
    }
  }
  return depth === 0;
}


/**
 * What a self-correction retry keeps: the candidates that already validated,
 * minus any the new batch has proposed again.
 *
 * 04-extraction-graph.md says the loop drops "the offending operations" and
 * continues. The budget-spent branch does exactly that; the retry branch did
 * not, because `extract` replaces the batch wholesale and everything built
 * from the previous pass went with it. Golden 009 lost a claim the critic had
 * kept that way (19-value-to-a-user.md, "Follow-up: where the missing claims
 * go"), and unlike the critic's retry these operations were already built and
 * linted — there is nothing to ask a model for.
 *
 * **Two wordings of one claim both survive, and that is accepted.** A retry
 * often rewords a claim it re-proposes, which gives it a different slug, so
 * the collision check below does not see it — and nothing here can, since this
 * module is pure and the only thing that could tell them apart is an embedder.
 * Both reach the review and a person drops one. Greg's call, 2026-09-22; the
 * alternatives were a retry prompt naming what not to repeat, or asking the
 * model for the kept claims back the way the critic's retry does.
 *
 * A collision keeps the new candidate rather than the carried one: it comes
 * from a fresh pass, the rest of that batch is consistent with it, and two
 * operations on one signpost would fail the batch-wide target check anyway.
 * `operationKey`'s rule, transcribed — `add` keys on the id it would create,
 * everything else on the id it targets — so that this module keeps its "no
 * LLM, no IO, no imports from the graph" shape.
 */
export function carryValidated(
  carried: readonly CandidateOperations[],
  built: readonly CandidateOperations[],
): CandidateOperations[] {
  const proposed = new Set(built.flatMap((candidate) => candidate.operations.map(signpostOf)));
  const kept = carried.filter(
    (candidate) => !candidate.operations.some((operation) => proposed.has(signpostOf(operation))),
  );
  return [...kept, ...built];
}

/**
 * The signpost an operation is about, existing or about to exist. Distinct
 * from `targetOf` above, which answers "which existing signpost does this
 * touch" and is undefined for an `add` — here an `add` is exactly the case
 * that has to collide.
 */
function signpostOf(operation: Operation): string {
  return operation.op === OPERATION_TAGS.add ? operation.signpost.id : operation.id;
}
