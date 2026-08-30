// Node 7, `validate` — deterministic. The self-correction loop's judge.
//
// Builds the proposed operations from the classifications and resolutions,
// then schema-lints them (src/core/graph/validate-operations.ts). On failure
// it routes back to `extract` with the specific errors attached, bounded at
// MAX_VALIDATE_ATTEMPTS; once that budget is spent the offending candidates
// are dropped and the valid ones carry on. **A bad candidate never fails the
// run.**
//
// It runs before `confidence_gate`, and the order is load-bearing: gating
// first would sort schema-invalid operations into the auto or human
// partitions before anything had checked them. The gate's job is to route
// valid operations; validate's job is to drop the rest.
//
// The node is deferred (see ../graph.ts) so it runs once, after every
// `classify` and `resolve_conflict` task has finished, rather than once per
// arriving branch.

import { buildOperations } from "../../core/graph/operations.ts";
import { validateOperations } from "../../core/graph/validate-operations.ts";
import { validateRoute } from "../../core/graph/routing.ts";
import type { ExtractionState, ExtractionUpdate } from "../state.ts";
import type { GraphPorts } from "../ports.ts";

export function makeValidateNode(ports: GraphPorts) {
  return async function validateNode(state: ExtractionState): Promise<ExtractionUpdate> {
    const existingIds = await ports.index.existingIds(state.repo);

    const built = buildOperations({
      candidates: state.candidates,
      classifications: state.classifications,
      resolutions: state.resolutions,
      sessionId: state.sessionId,
      author: ports.author,
      now: ports.now().toISOString(),
      existingIds,
    });

    const { valid, errors } = validateOperations({ built, existingIds });
    const attempts = state.validateAttempts + 1;

    // `valid` is written on every branch, retry included. A retry replaces the
    // candidates wholesale, so the write is harmless there, and writing it
    // unconditionally means the "drop and continue" branch needs no special
    // case: it is just this write with the errors left in place for the log.
    return { validated: valid, validationErrors: errors, validateAttempts: attempts };
  };
}

/** Re-exported so ../graph.ts's edge and the node stay one decision. */
export { validateRoute };
