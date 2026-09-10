// Shared formatter for ZodError -> one line per issue, "path: message".
// Used wherever a schema failure needs to be reported to a human as a
// short, readable summary instead of zod's raw multi-line issues dump.

import { ZodError } from "zod";

export function formatZodError(error: ZodError): string {
  const lines = error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  return lines.join("\n");
}

/**
 * The same idea on one line: "path: message; path: message".
 *
 * Used where the summary is embedded in a sentence rather than printed as a
 * block — a thrown Error's message, or a validation error handed back to a
 * model. A root-level issue has an empty path, which would otherwise render as
 * a bare ": message"; "(root)" says which value was wrong.
 */
export function summariseIssues(
  issues: readonly { path: PropertyKey[]; message: string }[],
): string {
  return issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}

/**
 * Any thrown value as a line a person can read, with a ZodError rendered by
 * `formatZodError` rather than by its own `toString`.
 *
 * Here rather than copied into each caller: the same two-branch expression was
 * written out in `src/cli/commands/index.ts`, `src/io/commit/commit-port.ts`
 * and `src/cli/commands/worker.ts`, each free to drift on how a schema failure
 * renders — and how a schema failure renders is the whole point of this module.
 */
export function describeError(error: unknown): string {
  if (error instanceof ZodError) {
    return formatZodError(error);
  }
  return error instanceof Error ? error.message : String(error);
}
