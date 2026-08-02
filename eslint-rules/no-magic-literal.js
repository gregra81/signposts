// Custom eslint rule: a numeric or string literal under src/ (outside
// the constants module itself) that duplicates a value exported by the
// constants module is an error. Enforces 13-constants.md's "referenced
// by name from code — no magic numbers inline": re-tuning a constant
// should stay a one-line change there, not a scattered find-and-replace.
//
// Exempt: the constants module itself, 0, 1, "", regex-valued constants
// (never collected, since a regex literal's value isn't a string or a
// number), object-property keys (a key is not "a value duplicating a
// constant"), and strings under 4 characters — otherwise short values
// like TOKEN_PREFIXES' "sk-" or "AKIA" would false-positive on nearly
// every string literal in the codebase.
//
// The constants module doesn't exist yet at the time this rule was
// written — it lands in a later build step. When its file is absent,
// unreadable, or fails to parse (e.g. mid-edit), the rule no-ops rather
// than erroring the whole lint run.

import fs from "node:fs";
import path from "node:path";
import { parse } from "@typescript-eslint/parser";
import { PROJECT_ROOT, relativeFilename } from "./lib/paths.js";

// Checked in order; the first one that exists on disk is used. A list
// rather than one guess, because the exact filename the constants
// module lands under (step 2) isn't settled yet.
export const DEFAULT_CANDIDATE_CONSTANTS_MODULES = [
  "src/core/config/constants.ts",
  "src/core/constants.ts",
  "src/core/config/constants/index.ts",
];

const EXEMPT_VALUES = new Set([0, 1, ""]);
const MIN_STRING_LENGTH = 4;

/**
 * @param {string[]} candidates relative paths, checked in order
 * @param {string} root
 * @returns {string | undefined} the first candidate that exists, as an absolute path
 */
export function findExistingModule(candidates, root) {
  for (const candidate of candidates) {
    const absolute = path.resolve(root, candidate);
    if (fs.existsSync(absolute)) {
      return absolute;
    }
  }
  return undefined;
}

/** @param {any} node */
function unwrapTypeAssertion(node) {
  let current = node;
  while (
    current &&
    (current.type === "TSAsExpression" || current.type === "TSSatisfiesExpression")
  ) {
    current = current.expression;
  }
  return current;
}

// Cache of parsed constants values, keyed by absolute path, invalidated
// by mtime. Rules are re-created per linted file, so without this a
// project with N files under src/ would re-read and re-parse the
// constants module N times per lint run.
const constantsCache = new Map();

/**
 * Collect every eligible number/string literal exported by the
 * constants module: top-level `export const NAME = <literal>`, and for
 * array-valued constants like TOKEN_PREFIXES, each literal element.
 *
 * @param {string} absolutePath
 * @returns {Set<string | number> | undefined} undefined if the module is missing or fails to parse
 */
function loadConstantValues(absolutePath) {
  let stat;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    return undefined;
  }

  const cached = constantsCache.get(absolutePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.values;
  }

  let ast;
  try {
    const source = fs.readFileSync(absolutePath, "utf8");
    ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch {
    // Missing, unreadable, or (e.g. mid-edit) unparseable — no-op
    // rather than crashing the lint run.
    return undefined;
  }

  const values = new Set();

  /** @param {any} node */
  function collect(node) {
    const unwrapped = unwrapTypeAssertion(node);
    if (!unwrapped) {
      return;
    }
    if (unwrapped.type === "Literal") {
      if (typeof unwrapped.value === "string" || typeof unwrapped.value === "number") {
        values.add(unwrapped.value);
      }
      return;
    }
    if (unwrapped.type === "ArrayExpression") {
      for (const element of unwrapped.elements) {
        if (element) {
          collect(element);
        }
      }
    }
  }

  for (const statement of ast.body) {
    if (statement.type !== "ExportNamedDeclaration" || !statement.declaration) {
      continue;
    }
    if (statement.declaration.type !== "VariableDeclaration") {
      continue;
    }
    for (const declarator of statement.declaration.declarations) {
      if (declarator.init) {
        collect(declarator.init);
      }
    }
  }

  constantsCache.set(absolutePath, { mtimeMs: stat.mtimeMs, values });
  return values;
}

/** @param {string | number} value */
function isExempt(value) {
  if (EXEMPT_VALUES.has(value)) {
    return true;
  }
  return typeof value === "string" && value.length < MIN_STRING_LENGTH;
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow a numeric or string literal in src/ that duplicates a value exported by the constants module.",
    },
    schema: [
      {
        type: "object",
        properties: {
          constantsModule: { type: "string" },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      duplicatesConstant:
        "This literal duplicates a value exported by the constants module ({{constantsModule}}). Reference the named constant instead of repeating its value.",
    },
  },
  create(context) {
    const relative = relativeFilename(context);
    if (!relative.startsWith("src/")) {
      return {};
    }

    const configuredModule = context.options[0]?.constantsModule;
    let absoluteConstantsModule;
    let constantsModuleRelative;
    if (configuredModule) {
      constantsModuleRelative = configuredModule.replaceAll("\\", "/");
      absoluteConstantsModule = path.resolve(PROJECT_ROOT, configuredModule);
    } else {
      absoluteConstantsModule = findExistingModule(
        DEFAULT_CANDIDATE_CONSTANTS_MODULES,
        PROJECT_ROOT,
      );
      if (!absoluteConstantsModule) {
        return {};
      }
      constantsModuleRelative = path
        .relative(PROJECT_ROOT, absoluteConstantsModule)
        .replaceAll("\\", "/");
    }

    if (relative === constantsModuleRelative) {
      return {};
    }

    const values = loadConstantValues(absoluteConstantsModule);
    if (!values || values.size === 0) {
      return {};
    }

    return {
      Literal(node) {
        const parent = node.parent;
        if (
          parent &&
          "source" in parent &&
          /** @type {any} */ (parent).source === node
        ) {
          // Module specifiers, not values.
          return;
        }
        if (parent && /** @type {any} */ (parent).type === "TSLiteralType") {
          // Type-level literals (e.g. `type X = "bar"`), not values.
          return;
        }
        if (
          parent &&
          parent.type === "Property" &&
          !parent.computed &&
          parent.key === node
        ) {
          // A property key is not a value duplicating a constant.
          return;
        }

        const value = node.value;
        if (
          (typeof value !== "string" && typeof value !== "number") ||
          isExempt(value)
        ) {
          return;
        }

        if (values.has(value)) {
          context.report({
            node,
            messageId: "duplicatesConstant",
            data: { constantsModule: constantsModuleRelative },
          });
        }
      },
    };
  },
};

export default rule;
