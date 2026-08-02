// Custom eslint rule: in a constants module, a string literal that
// duplicates the name it is bound to (e.g. `export const FOO = "FOO"`) is
// an error. Applies to files matching **/constants.{ts,js,mts,cts,mjs,cjs}
// or **/constants/**/*.{ts,js,mts,cts,mjs,cjs}.
//
// Assumption: "duplicates the name" is judged case-insensitively, without
// stripping any characters, so `FOO`/`"foo"` count as duplicating an
// identifier named `FOO`, but `"Foo!"` does not.

import { relativeFilename } from "./lib/paths.js";

const EXTENSION = /\.(ts|js|mts|cts|mjs|cjs)$/;
const CONSTANTS_FILE = /(^|\/)constants\.(ts|js|mts|cts|mjs|cjs)$/;
const CONSTANTS_DIR = /(^|\/)constants\//;

/** @param {string} relative */
function isConstantsModule(relative) {
  return (
    CONSTANTS_FILE.test(relative) ||
    (CONSTANTS_DIR.test(relative) && EXTENSION.test(relative))
  );
}

/** @param {string} value */
function normalize(value) {
  return value.toLowerCase();
}

/** @typedef {import('@typescript-eslint/types').TSESTree.Expression} TSExpression */

/** @param {TSExpression} node */
function unwrapTypeAssertion(node) {
  let current = node;
  while (
    current.type === "TSAsExpression" ||
    current.type === "TSSatisfiesExpression"
  ) {
    current = current.expression;
  }
  return current;
}

/** @param {TSExpression} node */
function getStringLiteralValue(node) {
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    const quasi = node.quasis[0];
    return quasi ? quasi.value.cooked : undefined;
  }
  return undefined;
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow a string literal that duplicates the name of the constant it is bound to.",
    },
    schema: [],
    messages: {
      selfNamed:
        'Constant "{{name}}" is bound to a string literal that duplicates its own name. Give the value real content instead of repeating the identifier.',
    },
  },
  create(context) {
    if (!isConstantsModule(relativeFilename(context))) {
      return {};
    }

    return {
      VariableDeclarator(node) {
        if (node.id.type !== "Identifier" || !node.init) {
          return;
        }

        const init = /** @type {TSExpression} */ (node.init);
        const literal = unwrapTypeAssertion(init);
        const value = getStringLiteralValue(literal);

        if (
          typeof value === "string" &&
          normalize(value) === normalize(node.id.name)
        ) {
          context.report({
            node: literal,
            messageId: "selfNamed",
            data: { name: node.id.name },
          });
        }
      },
    };
  },
};

export default rule;
