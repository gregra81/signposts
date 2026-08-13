// Confidence gate (06-review-and-pr.md, 16-build-plan.md step 13). PURE, no
// IO — operation, confidence, and bootstrap flag in, routing decision out.
// Bootstrap state itself lives in the DB (src/io/db/repo-state.ts); this
// function just takes the already-read flag as a plain boolean.

import { ALWAYS_HUMAN_OPS, AUTO_PUBLISH_CONFIDENCE, BOOTSTRAP_GATE_ALL } from "../config/constants.js";

// Minimal Operation type, scoped to what gate() actually reads: the `op`
// tag. 12-wire-contracts.md's Operation union carries richer per-variant
// payloads (Signpost, Scope, ...), but nothing here switches on them, so
// per contracts/schema.ts's YAGNI precedent, only the tag is modelled.
export type Operation = { op: "add" | "reinforce" | "refine" | "supersede" | "retire" };

export type GateResult = "auto" | "needsHuman";

const ALWAYS_HUMAN_OPS_SET: ReadonlySet<string> = new Set(ALWAYS_HUMAN_OPS);

/**
 * refine/supersede/retire always route to a human, regardless of
 * confidence or bootstrap. reinforce is provenance-only (no content
 * change) so it always routes auto, except during bootstrap. add routes
 * auto only when confidence clears AUTO_PUBLISH_CONFIDENCE, also except
 * during bootstrap.
 */
export function gate(operation: Operation, confidence: number, isBootstrap: boolean): GateResult {
  if (ALWAYS_HUMAN_OPS_SET.has(operation.op)) {
    return "needsHuman";
  }

  if (isBootstrap && BOOTSTRAP_GATE_ALL) {
    return "needsHuman";
  }

  if (operation.op === "reinforce") {
    return "auto";
  }

  return confidence >= AUTO_PUBLISH_CONFIDENCE ? "auto" : "needsHuman";
}
