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
    const candidateErrors = checkCandidate(candidate, existingIds, claimedTargets);
    if (candidateErrors.length > 0) {
      errors.push(...candidateErrors);
      continue;
    }
    for (const target of targetsOf(candidate.operations)) {
      claimedTargets.add(target);
    }
    valid.push(candidate);
  }

  return { valid, errors };
}

function checkCandidate(
  candidate: CandidateOperations,
  existingIds: ReadonlySet<string>,
  claimedTargets: ReadonlySet<string>,
): string[] {
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
        `${candidate.tempId}: operation failed schema validation: ${issueSummary(parsed.error.issues)}`,
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

  return errors;
}

/** The existing signpost an operation acts on, or undefined for a pure `add`. */
function targetOf(operation: Operation): string | undefined {
  return operation.op === OPERATION_TAGS.add ? undefined : operation.id;
}

function targetsOf(operations: readonly Operation[]): string[] {
  return operations.map(targetOf).filter((target): target is string => target !== undefined);
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

function issueSummary(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}
