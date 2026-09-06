// What the four operations do to the corpus on disk (03-memory-model.md,
// "Operations"). Pure: the parsed corpus and the operations go in, the corpus
// that should replace it comes out, along with which ids changed.
//
// Separated from the writing so the decision — which file gains a session id,
// which claim is replaced, which signpost stops being active — is testable
// without a filesystem, and so the write itself is all-or-nothing: everything
// is computed before anything is written.
//
// An operation naming an id no file carries throws rather than being skipped.
// It means the corpus moved under the run (a file deleted while it was
// halted, a merge that removed one), and applying the rest would write a
// partial result nobody asked for.

import { OPERATION_TAGS, type Operation } from "../contracts/graph.ts";
import { statusSchema, type Signpost } from "./schema.ts";

/** `.signposts/<category>/<id>.md` — the layout 03-memory-model.md specifies. */
export function signpostPath(signpost: Signpost): string {
  return `${signpost.category}/${signpost.id}.md`;
}

export interface AppliedOperations {
  /** The corpus as it should now be on disk, in the order the input had it. */
  corpus: Signpost[];
  /** Ids whose file must be rewritten — everything else is untouched. */
  changed: string[];
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

  const replace = (signpost: Signpost): void => {
    if (!byId.has(signpost.id)) {
      order.push(signpost.id);
    }
    byId.set(signpost.id, signpost);
    changed.add(signpost.id);
  };

  const existing = (id: string, op: string): Signpost => {
    const signpost = byId.get(id);
    if (signpost === undefined) {
      throw new Error(`${op} names ${id}, which is not in .signposts/`);
    }
    return signpost;
  };

  for (const operation of input.operations) {
    switch (operation.op) {
      case OPERATION_TAGS.add:
        replace(operation.signpost);
        break;

      // Provenance only, never content: a claim independently restated by
      // another session is stronger evidence for the same claim, which is the
      // whole reason reinforce is not a no-op (03-memory-model.md).
      case OPERATION_TAGS.reinforce: {
        const target = existing(operation.id, operation.op);
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
  };
}

function union(values: readonly string[], value: string): string[] {
  return values.includes(value) ? [...values] : [...values, value];
}
