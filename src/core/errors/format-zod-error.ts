// Shared formatter for ZodError -> one line per issue, "path: message".
// Used wherever a schema failure needs to be reported to a human as a
// short, readable summary instead of zod's raw multi-line issues dump.

import type { ZodError } from "zod";

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
