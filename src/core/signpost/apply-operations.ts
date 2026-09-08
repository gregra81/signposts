// What the four operations do to the corpus on disk (03-memory-model.md,
// "Operations"). Pure: the parsed corpus and the operations go in, the corpus
// that should replace it comes out, along with which ids changed.
//
// Separated from the writing so the decision — which file gains a session id,
// which claim is replaced, which signpost stops being active — is testable
// without a filesystem, and so the write itself is all-or-nothing: everything
// is computed before anything is written.
//
// An operation that cannot be applied is reported in `skipped` and the rest
// are applied. It used to throw, which reads as the safer choice and is not:
// this runs in the last node, so the exception escaped `commit`, escaped
// `graph.invoke`, and lost a session the developer had answered call by call
// — and the checkpoint survived, so the next run resumed straight back into
// the same throw with no way out but deleting the branch.
//
// Both ways it happens are ordinary rather than corrupt. The corpus this is
// applied to is the *branch's*, while the ids the graph proposes come from the
// mirror of the *base* branch, and nothing merges the base into the branch —
// so a teammate's merged signpost is an id `reinforce` can name and the branch
// does not carry. In the other direction `--first` clears the pending rows, so
// an id proposed on the branch by an earlier run drops out of `existingIds`
// and `generateSlug` can mint it again.
//
// What must not happen is an `add` writing over a claim that is already there,
// replacing its evidence and provenance while the pull request still calls the
// row an `add` (src/io/db/pending-index.ts refuses the same thing). Skipping
// refuses that just as firmly as throwing did, and keeps the session.

import { OPERATION_TAGS, type Operation } from "../contracts/graph.ts";
import { statusSchema, type Signpost } from "./schema.ts";

/** `.signposts/<category>/<id>.md` — the layout 03-memory-model.md specifies. */
export function signpostPath(signpost: Signpost): string {
  return `${signpost.category}/${signpost.id}.md`;
}

/** An operation that could not be applied, and why — for the caller to report. */
export interface SkippedOperation {
  op: string;
  id: string;
  reason: string;
}

export interface AppliedOperations {
  /** The corpus as it should now be on disk, in the order the input had it. */
  corpus: Signpost[];
  /** Ids whose file must be rewritten — everything else is untouched. */
  changed: string[];
  /** Operations left unapplied. Empty on the ordinary path. */
  skipped: SkippedOperation[];
}

export interface ApplyOperationsInput {
  corpus: readonly Signpost[];
  operations: readonly Operation[];
  /** ISO date, from the injected clock. Only `reinforce` records it. */
  now: string;
}

export function applyOperations(input: ApplyOperationsInput): AppliedOperations {
  const byId = new Map(input.corpus.map((signpost) => [signpost.id, signpost]));
  const order = input.corpus.map((signpost) => signpost.id);
  const changed = new Set<string>();
  const skipped: SkippedOperation[] = [];

  const replace = (signpost: Signpost): void => {
    if (!byId.has(signpost.id)) {
      order.push(signpost.id);
    }
    byId.set(signpost.id, signpost);
    changed.add(signpost.id);
  };

  const existing = (id: string, op: string): Signpost | undefined => {
    const signpost = byId.get(id);
    if (signpost === undefined) {
      skipped.push({ op, id, reason: `${id} is not in .signposts/ on this branch` });
    }
    return signpost;
  };

  for (const operation of input.operations) {
    switch (operation.op) {
      // Never over an id that is already there — see the header.
      case OPERATION_TAGS.add:
        if (byId.has(operation.signpost.id)) {
          skipped.push({
            op: operation.op,
            id: operation.signpost.id,
            reason: `.signposts/ already carries ${operation.signpost.id} on this branch`,
          });
          break;
        }
        replace(operation.signpost);
        break;

      // Provenance only, never content: a claim independently restated by
      // another session is stronger evidence for the same claim, which is the
      // whole reason reinforce is not a no-op (03-memory-model.md).
      case OPERATION_TAGS.reinforce: {
        const target = existing(operation.id, operation.op);
        if (target === undefined) {
          break;
        }
        replace({
          ...target,
          provenance: {
            ...target.provenance,
            session_ids: union(target.provenance.session_ids, operation.sessionId),
            authors: union(target.provenance.authors, operation.author),
            last_reinforced: input.now,
          },
        });
        break;
      }

      // Only the fields the operation names. A refine that carried no claim
      // is narrowing the scope of a contradiction resolved `both_scoped`, and
      // overwriting the claim with an absent one would erase it.
      case OPERATION_TAGS.refine: {
        const target = existing(operation.id, operation.op);
        if (target === undefined) {
          break;
        }
        replace({
          ...target,
          ...(operation.claim === undefined ? {} : { claim: operation.claim }),
          ...(operation.evidence === undefined ? {} : { evidence: operation.evidence }),
          ...(operation.scope === undefined ? {} : { scope: operation.scope }),
        });
        break;
      }

      // The old file stays, marked superseded. It is history, and a diff that
      // deletes it would lose why the team believed it.
      case OPERATION_TAGS.supersede: {
        const target = existing(operation.id, operation.op);
        if (target === undefined) {
          break;
        }
        replace({ ...target, status: statusSchema.enum.superseded });
        replace(operation.replacement);
        break;
      }

      case OPERATION_TAGS.retire:
        // Unreachable: no classification path emits `retire`
        // (03-memory-model.md). Refusing beats inventing what a file should
        // look like once a claim is "no longer true".
        throw new Error(`retire has no write semantics yet (${operation.id}: ${operation.reason})`);
    }
  }

  return {
    corpus: order.map((id) => byId.get(id)!),
    changed: order.filter((id) => changed.has(id)),
    skipped,
  };
}

function union(values: readonly string[], value: string): string[] {
  return values.includes(value) ? [...values] : [...values, value];
}
