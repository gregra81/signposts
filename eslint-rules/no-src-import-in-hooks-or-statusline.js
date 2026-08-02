// Custom eslint rule: files under hooks/ or statusline/ may not import
// from src/.

import path from "node:path";
import { relativeFilename } from "./lib/paths.js";
import { createImportVisitor } from "./lib/import-visitor.js";

const GUARDED_DIR = /^(hooks|statusline)\//;

/**
 * A specifier reaches into src/ if it's a relative import that resolves
 * into <cwd>/src, or a "#"-prefixed subpath import aliasing into src/.
 * Bare npm specifiers (even ones containing "/src/", e.g. "some-pkg/src/x")
 * are never flagged.
 */
/**
 * @param {string} specifier
 * @param {string} fileDir
 * @param {string} srcDir
 */
function reachesIntoSrc(specifier, fileDir, srcDir) {
  if (specifier.startsWith(".")) {
    const resolved = path.resolve(fileDir, specifier);
    return resolved === srcDir || resolved.startsWith(srcDir + path.sep);
  }
  if (specifier.startsWith("#")) {
    const aliased = specifier.slice(1);
    return aliased === "src" || aliased.startsWith("src/");
  }
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow importing from src/ inside hooks/ or statusline/.",
    },
    schema: [],
    messages: {
      forbidden:
        "Files under hooks/ or statusline/ may not import from src/.",
    },
  },
  create(context) {
    if (!GUARDED_DIR.test(relativeFilename(context))) {
      return {};
    }

    const fileDir = path.dirname(path.resolve(context.cwd, context.filename));
    const srcDir = path.resolve(context.cwd, "src");

    return createImportVisitor(
      (specifier, node) => {
        if (reachesIntoSrc(specifier, fileDir, srcDir)) {
          context.report({ node, messageId: "forbidden" });
        }
      },
      { includeRequire: true },
    );
  },
};

export default rule;
