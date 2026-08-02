// Shared ESLint visitor factory for rules that need to inspect every
// static import/export/require specifier in a file. Both current callers
// need require() covered too (SDK imports and src/ reach-ins can both
// arrive via require()), so it's always included rather than gated
// behind an option nobody turns off.

/**
 * @param {(specifier: string, node: import('estree').Node) => void} checkSpecifier
 * @returns {import('eslint').Rule.RuleListener}
 */
export function createImportVisitor(checkSpecifier) {
  /**
   * @param {import('estree').ImportDeclaration | import('estree').ExportNamedDeclaration | import('estree').ExportAllDeclaration} node
   */
  function checkSource(node) {
    if (node.source && typeof node.source.value === "string") {
      checkSpecifier(node.source.value, node);
    }
  }

  return {
    ImportDeclaration: checkSource,
    ExportNamedDeclaration: checkSource,
    ExportAllDeclaration: checkSource,
    /** @param {import('estree').ImportExpression} node */
    ImportExpression(node) {
      if (node.source.type === "Literal" && typeof node.source.value === "string") {
        checkSpecifier(node.source.value, node);
      }
    },
    /** @param {import('estree').CallExpression} node */
    CallExpression(node) {
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
    },
  };
}
