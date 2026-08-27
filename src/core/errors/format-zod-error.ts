// Shared formatter for ZodError -> one line per issue, "path: message".
// Used wherever a schema failure needs to be reported to a human as a
// short, readable summary instead of zod's raw multi-line issues dump.

import type { ZodError } from "zod";

export function formatZodError(error: ZodError): string {
  const lines = error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  return lines.join("\n");
}
