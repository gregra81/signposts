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
  redactEmails,
  redactEnvSecrets,
  redactHighEntropy,
  redactPrivateKeys,
  redactTokens,
} from "./patterns.ts";
import type { Redactor } from "./types.ts";

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

/**
 * Every redactor 02-ingestion.md requires before text leaves the machine —
 * the secret patterns above plus email pseudonymisation. **This is the set a
 * caller sending text to a model wants**, and the only reason it is not
 * `defaultRedactors()` itself is the repoRoot argument, which pins a
 * pseudonym to a repo and which a bare `(text) => string` cannot carry.
 *
 * Required, not optional: an optional repoRoot would let a caller who forgot
 * it ship every colleague's address to the model and see no error, which is
 * the failure this exists to close.
 *
 * Emails go last. Each earlier stage consumes text this one would otherwise
 * also match — a `postgres://user:pass@host.com/db` is a connection string,
 * not a person — and none of them can match a pseudonym, so the order is
 * stable in only this direction.
 */
export function wireRedactors(repoRoot: string): readonly Redactor[] {
  return [...defaultRedactors(), redactEmails(repoRoot)];
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
