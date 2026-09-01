// Applies the operations a run produced to an in-memory mirror, producing the
// mirror the next run starts from.
//
// This is what makes a multi-session scenario possible. A single-session
// fixture can only ever assert a mirror state by hand, which is an assertion
// about what memory formation would produce rather than a demonstration of
// it. Threading real operations from step to step means the state a later
// session sees was built by the earlier ones — the only way `reinforce` (which
// exists purely to accumulate provenance across sessions) can be exercised at
// all.
//
// PURE: current signposts and operations in, next signposts out. The real
// CommitPort writes markdown and opens a PR for the same operations; this is
// the same semantics without the IO, and the two agreeing is what makes a
// scenario's expected state meaningful.

import {
  OPERATION_TAGS,
  type Operation,
} from "../../core/contracts/graph.ts";
import { SUPERSEDED_STATUS, type Signpost } from "../../core/signpost/schema.ts";
import { ISO_DATE_CHARS } from "../../core/config/constants.ts";

/** `reinforce` records that a second session said the same thing. */
function reinforced(existing: Signpost, sessionId: string, author: string, now: Date): Signpost {
  const seen = new Set(existing.provenance.session_ids);
  const authors = new Set(existing.provenance.authors);
  seen.add(sessionId);
  authors.add(author);
  return {
    ...existing,
    provenance: {
      ...existing.provenance,
      session_ids: [...seen],
      authors: [...authors],
      last_reinforced: now.toISOString().slice(0, ISO_DATE_CHARS),
    },
  };
}

export function applyOperations(
  current: readonly Signpost[],
  operations: readonly Operation[],
  now: Date,
): Signpost[] {
  const byId = new Map(current.map((s) => [s.id, s]));

  for (const operation of operations) {
    switch (operation.op) {
      case OPERATION_TAGS.add:
        byId.set(operation.signpost.id, operation.signpost);
        break;

      case OPERATION_TAGS.reinforce: {
        const existing = byId.get(operation.id);
        if (existing !== undefined) {
          byId.set(operation.id, reinforced(existing, operation.sessionId, operation.author, now));
        }
        break;
      }

      case OPERATION_TAGS.refine: {
        const existing = byId.get(operation.id);
        if (existing !== undefined) {
          byId.set(operation.id, {
            ...existing,
            ...(operation.claim === undefined ? {} : { claim: operation.claim }),
            ...(operation.evidence === undefined ? {} : { evidence: operation.evidence }),
            ...(operation.scope === undefined ? {} : { scope: operation.scope }),
          });
        }
        break;
      }

      case OPERATION_TAGS.supersede: {
        const existing = byId.get(operation.id);
        if (existing !== undefined) {
          // The old claim stays in the mirror as history, marked superseded —
          // it is not deleted, and the replacement records what it replaced.
          byId.set(operation.id, { ...existing, status: SUPERSEDED_STATUS });
        }
        byId.set(operation.replacement.id, {
          ...operation.replacement,
          supersedes: [operation.id],
        });
        break;
      }

      case OPERATION_TAGS.retire: {
        const existing = byId.get(operation.id);
        if (existing !== undefined) {
          byId.set(operation.id, { ...existing, status: SUPERSEDED_STATUS });
        }
        break;
      }
    }
  }

  return [...byId.values()];
}
