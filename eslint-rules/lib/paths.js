// Shared helper for eslint-rules/: resolve a rule's target filename
// relative to the project root, with backslashes normalized so path
// checks behave the same on Windows and POSIX.
//
// Resolved against PROJECT_ROOT (derived from this file's own location)
// rather than context.cwd, because context.cwd tracks wherever eslint
// was invoked from and shifts if that ever differs from the repo root.

import path from "node:path";
import { fileURLToPath } from "node:url";

// This file lives at <root>/eslint-rules/lib/paths.js.
export const PROJECT_ROOT = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);

/**
 * @param {import('eslint').Rule.RuleContext} context
 * @returns {string}
 */
export function relativeFilename(context) {
  return path.relative(PROJECT_ROOT, context.filename).replaceAll("\\", "/");
}
