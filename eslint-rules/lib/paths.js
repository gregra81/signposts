// Shared helper for eslint-rules/: resolve a rule's target filename
// relative to the lint run's cwd, with backslashes normalized so path
// checks behave the same on Windows and POSIX.

import path from "node:path";

/**
 * @param {import('eslint').Rule.RuleContext} context
 * @returns {string}
 */
export function relativeFilename(context) {
  return path.relative(context.cwd, context.filename).replaceAll("\\", "/");
}
