// The redactor (02-ingestion.md "Redaction", 15-spec.md #16/#17,
// 16-build-plan.md Tier 1 #2). PURE, no LLM call, no IO — text in, text
// out. Order: gutter first, redact second (D3), so this runs over
// already-reduced text.
//
// FAIL_MODE is "closed" (13-constants.md): redact() itself never
// swallows an error and falls back to raw text — it propagates. safeRedact
// is the boundary a caller uses to turn that propagation into "skip this
// transcript" instead of a crash.

import {
  redactConnectionStrings,
  redactEnvSecrets,
  redactHighEntropy,
  redactPrivateKeys,
  redactTokens,
} from "./patterns.js";
import type { Redactor } from "./types.js";

/**
 * Applied in this order because each earlier stage consumes text a later,
 * broader stage would otherwise also match (a PEM block's body is itself
 * high-entropy; a connection string's password may satisfy the env-secret
 * key-name check if left for that stage to see first).
 *
 * A function, not a module-level array: stryker.config.mjs sets
 * ignoreStatic: true, so a top-level array literal is evaluated once at
 * import and its mutants (wrong order, a dropped stage) are excluded from
 * scoring rather than counted. Called fresh as each default parameter's
 * initializer below, this stays mutation-testable.
 */
export function defaultRedactors(): readonly Redactor[] {
  return [redactPrivateKeys, redactConnectionStrings, redactEnvSecrets, redactTokens, redactHighEntropy];
}

/** Runs every redactor in sequence. Throws if any redactor throws — does not fall back to raw text. */
export function redact(text: string, redactors: readonly Redactor[] = defaultRedactors()): string {
  return redactors.reduce((current, redactor) => redactor(current), text);
}

export type SafeRedactResult = { ok: true; text: string } | { ok: false };

/**
 * Fail-closed boundary (FAIL_MODE=closed): a redactor throwing means the
 * transcript is skipped entirely, never sent with whatever redaction
 * happened to complete before the throw.
 */
export function safeRedact(text: string, redactors: readonly Redactor[] = defaultRedactors()): SafeRedactResult {
  try {
    return { ok: true, text: redact(text, redactors) };
  } catch {
    return { ok: false };
  }
}
