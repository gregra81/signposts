// Turns each classified candidate into the operation(s) `commit` will apply
// (12-wire-contracts.md's `Operation` union). Runs between `classify` /
// `resolve_conflict` and `validate`, and is the last place a decision is made
// before the gate routes what comes out of it.
//
// The mapping from ClassificationKind to Operation is the one implied by
// 12-wire-contracts.md's two unions read together — 04-extraction-graph.md
// names the classifications and names the operations, and this is the join:
//
//   NOVEL          -> add
//   DUPLICATE      -> reinforce         (provenance only, never a second file)
//   REFINEMENT     -> refine
//   CONTRADICTION  -> depends on the resolution (below)
//
// and for a contradiction, keyed on Resolution.outcome:
//
//   new_wins       -> supersede         (the new claim replaces the old)
//   existing_wins  -> nothing           (the old claim stands; we learned nothing new)
//   both_scoped    -> refine + add      (narrow the old, add the new under its own scope)
//   undecidable    -> add               (gated to a human — see gateReasonFor)
//
// PURE: candidates, classifications, resolutions and a clock reading in;
// operations out. No id lookup against the database — `existingIds` is passed
// in so slug generation stays a pure function of what the caller already read.

import { ACTIVE_STATUS, type Signpost } from "../signpost/schema.ts";
import { generateSlug } from "../signpost/slug.ts";
import {
  CLASSIFICATION_KINDS,
  OPERATION_TAGS,
  RESOLUTION_OUTCOMES,
  type Candidate,
  type CandidateOperations,
  type Classification,
  type Operation,
  type Resolution,
} from "../contracts/graph.ts";

export interface BuildOperationsInput {
  candidates: readonly Candidate[];
  classifications: Readonly<Record<string, Classification>>;
  resolutions: Readonly<Record<string, Resolution>>;
  sessionId: string;
  /** REAL `git config user.email` — never a pseudonym. */
  author: string;
  /** ISO date, from the injected clock. */
  now: string;
  /** Signpost ids already in use in this repo, so generated slugs do not collide. */
  existingIds: ReadonlySet<string>;
}

export function buildOperations(input: BuildOperationsInput): CandidateOperations[] {
  // Mutable across the loop so two candidates in the same run cannot be
  // handed the same slug.
  const takenIds = new Set(input.existingIds);
  const built: CandidateOperations[] = [];

  for (const candidate of input.candidates) {
    const classification = input.classifications[candidate.tempId];
    if (classification === undefined) {
      // No classification means the fan-out branch for this candidate did not
      // complete. Emitting nothing is right: we do not know how it relates to
      // what is already recorded, and guessing `add` would risk a duplicate.
      continue;
    }

    const operations = operationsFor({ ...input, candidate, classification, takenIds });
    if (operations.length > 0) {
      built.push({ tempId: candidate.tempId, confidence: candidate.confidence, operations });
    }
  }

  return built;
}

interface OperationsForInput extends BuildOperationsInput {
  candidate: Candidate;
  classification: Classification;
  takenIds: Set<string>;
}

function operationsFor(input: OperationsForInput): Operation[] {
  const { candidate, classification } = input;
  const relatedId = classification.relatedId;

  switch (classification.kind) {
    case CLASSIFICATION_KINDS.NOVEL:
      return [{ op: OPERATION_TAGS.add, signpost: toSignpost(input, candidate.scope) }];

    case CLASSIFICATION_KINDS.DUPLICATE:
      // relatedId is required for every non-NOVEL kind (contracts/graph.ts
      // enforces it on parse), but the type is still optional, so this reads
      // it defensively rather than asserting.
      return relatedId === undefined
        ? []
        : [{ op: OPERATION_TAGS.reinforce, id: relatedId, sessionId: input.sessionId, author: input.author }];

    case CLASSIFICATION_KINDS.REFINEMENT:
      return relatedId === undefined
        ? []
        : [
            {
              op: OPERATION_TAGS.refine,
              id: relatedId,
              claim: candidate.claim,
              evidence: candidate.evidence,
              scope: candidate.scope,
            },
          ];

    case CLASSIFICATION_KINDS.CONTRADICTION:
      return contradictionOperations(input, relatedId);
  }
}

function contradictionOperations(input: OperationsForInput, relatedId: string | undefined): Operation[] {
  const { candidate } = input;
  const resolution = input.resolutions[candidate.tempId];

  // An unresolved contradiction is not a reason to drop the candidate — it is
  // a reason to ask a person. Treated exactly like `undecidable`.
  if (resolution === undefined || resolution.outcome === RESOLUTION_OUTCOMES.undecidable) {
    return [{ op: OPERATION_TAGS.add, signpost: toSignpost(input, candidate.scope) }];
  }

  if (resolution.outcome === RESOLUTION_OUTCOMES.existing_wins) {
    return [];
  }

  if (relatedId === undefined) {
    return [];
  }

  if (resolution.outcome === RESOLUTION_OUTCOMES.new_wins) {
    return [
      {
        op: OPERATION_TAGS.supersede,
        id: relatedId,
        replacement: { ...toSignpost(input, candidate.scope), supersedes: [relatedId] },
      },
    ];
  }

  // both_scoped: narrow the existing claim to the scope the resolver worked
  // out, and add the new one under its own. Both stay true; neither is lost.
  // The schema requires both scopes for this outcome, so an absent one is
  // treated as nothing-to-do rather than silently rescoping to the candidate's.
  const { newScope, existingScope } = resolution;
  if (newScope === undefined || existingScope === undefined) {
    return [];
  }
  return [
    { op: OPERATION_TAGS.refine, id: relatedId, scope: existingScope },
    { op: OPERATION_TAGS.add, signpost: toSignpost(input, newScope) },
  ];
}

function toSignpost(input: OperationsForInput, scope: Signpost["scope"]): Signpost {
  const { candidate, now } = input;
  const id = generateSlug(candidate.claim, input.takenIds);
  input.takenIds.add(id);

  return {
    id,
    claim: candidate.claim,
    category: candidate.category,
    scope,
    evidence: candidate.evidence,
    confidence: candidate.confidence,
    provenance: {
      session_ids: [input.sessionId],
      authors: [input.author],
      first_seen: now,
      last_reinforced: now,
    },
    status: ACTIVE_STATUS,
  };
}
