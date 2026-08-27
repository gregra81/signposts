// Shapes for the redactor (13-constants.md "Redaction", 02-ingestion.md
// "Redaction", 15-spec.md #16/#17).

import { PLACEHOLDER_FORMAT } from "../config/constants.ts";

/** One entry per pattern category the redactor covers. */
export type RedactedKind = "private-key" | "connection-string" | "env-secret" | "token" | "high-entropy";

/** A single pass over text; replaces what it matches, leaves the rest untouched. */
export type Redactor = (text: string) => string;

const PLACEHOLDER_KIND_TOKEN = "<kind>";

/** Renders PLACEHOLDER_FORMAT for a specific kind, e.g. "[REDACTED:token]". */
export function placeholderFor(kind: RedactedKind): string {
  return PLACEHOLDER_FORMAT.replace(PLACEHOLDER_KIND_TOKEN, kind);
}
