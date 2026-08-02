// Custom eslint rule: importing "@anthropic-ai/sdk" (or any of its
// subpaths) is only allowed from files under src/io/model/. Everywhere
// else it is an error.

import { relativeFilename } from "./lib/paths.js";
import { createImportVisitor } from "./lib/import-visitor.js";

const SDK_SPECIFIER = "@anthropic-ai/sdk";
const SANCTIONED_PATH = "src/io/model/";

/** @param {string} value */
function isSdkSpecifier(value) {
  return value === SDK_SPECIFIER || value.startsWith(`${SDK_SPECIFIER}/`);
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        'Disallow importing "@anthropic-ai/sdk" outside src/io/model/.',
    },
    schema: [],
    messages: {
      forbidden:
        '"@anthropic-ai/sdk" may only be imported from files under src/io/model/.',
    },
  },
  create(context) {
    if (relativeFilename(context).startsWith(SANCTIONED_PATH)) {
      return {};
    }

    return createImportVisitor((specifier, node) => {
      if (isSdkSpecifier(specifier)) {
        context.report({ node, messageId: "forbidden" });
      }
    });
  },
};

export default rule;
