// Shared ESLint visitor factory for rules that need to inspect every
// static import/export/require specifier in a file.

/**
 * @param {(specifier: string, node: import('estree').Node) => void} checkSpecifier
 * @param {{ includeRequire?: boolean }} [options]
 * @returns {import('eslint').Rule.RuleListener}
 */
export function createImportVisitor(checkSpecifier, options = {}) {
  /**
   * @param {import('estree').ImportDeclaration | import('estree').ExportNamedDeclaration | import('estree').ExportAllDeclaration} node
   */
  function checkSource(node) {
    if (node.source && typeof node.source.value === "string") {
      checkSpecifier(node.source.value, node);
    }
  }

  /** @type {import('eslint').Rule.RuleListener} */
  const visitor = {
    ImportDeclaration: checkSource,
    ExportNamedDeclaration: checkSource,
    ExportAllDeclaration: checkSource,
    /** @param {import('estree').ImportExpression} node */
    ImportExpression(node) {
      if (node.source.type === "Literal" && typeof node.source.value === "string") {
        checkSpecifier(node.source.value, node);
      }
    },
  };

  if (options.includeRequire) {
    /** @param {import('estree').CallExpression} node */
    visitor.CallExpression = function (node) {
      const arg = node.arguments[0];
      if (
        node.callee.type === "Identifier" &&
        node.callee.name === "require" &&
        node.arguments.length === 1 &&
        arg &&
        arg.type === "Literal" &&
        typeof arg.value === "string"
      ) {
        checkSpecifier(arg.value, node);
      }
    };
  }

  return visitor;
}
