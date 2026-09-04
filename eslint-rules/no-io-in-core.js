// Custom eslint rule: src/core/ is pure. No filesystem, no network, no
// subprocess, no clock, no environment, no randomness.
//
// CLAUDE.md has said this since the repo was laid out, and nothing enforced
// it. `src/core/paths/confine.ts` imported `node:fs` and called lstat,
// readlink and realpath directly — for a real reason, since symlink
// resolution cannot be done from a string — and it sat there until someone
// happened to read the file and ask. The fix was a port passed as an
// argument, which is what the shape rule asks for; this rule is what makes
// the next one get caught on the way in rather than months later.
//
// **Allowlist, not denylist.** A list of banned builtins leaks: `node:fs`
// gets caught and `node:fs/promises` does not, `child_process` arrives
// without the `node:` prefix, and next year's builtin is not on anyone's
// list. So every Node builtin is an error under src/core/ unless it is named
// below, and adding one is a deliberate edit with a reason attached.

import { builtinModules } from "node:module";
import { relativeFilename } from "./lib/paths.js";
import { createImportVisitor } from "./lib/import-visitor.js";

const CORE_PATH = "src/core/";

/**
 * Builtins core may import, and for each either `null` (the whole module) or
 * the only bindings that are pure.
 *
 * `path` is string manipulation — `path.relative` and `path.join` make no
 * syscall. `crypto` is here only for hashing: `createHash` over the same
 * bytes is the same digest every time, which is why content hashes and slugs
 * can live in core at all. Its random functions are the opposite of that, so
 * they are not on the list.
 *
 * @type {Map<string, Set<string> | null>}
 */
const ALLOWED_BUILTINS = new Map([
  ["path", null],
  ["url", null],
  ["util", null],
  ["buffer", null],
  ["crypto", new Set(["createHash", "createHmac"])],
]);

/** Globals that read ambient state. `process.*` is all of them at once. */
const FORBIDDEN_GLOBALS = new Set(["process"]);

/** @param {string} specifier */
function builtinName(specifier) {
  const bare = specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
  // `node:fs/promises` and `fs/promises` are both the `fs` builtin.
  const root = bare.split("/")[0] ?? bare;
  // builtinModules lists a few entries only in prefixed form (node:test,
  // node:sea), so both spellings are checked.
  return builtinModules.includes(root) || builtinModules.includes(`node:${root}`)
    ? root
    : undefined;
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow filesystem, network, subprocess, clock, environment and randomness under src/core/.",
    },
    schema: [],
    messages: {
      forbiddenModule:
        "src/core/ is pure: \"{{specifier}}\" reads ambient state or does IO. Put it under src/io/, or take what you need as an argument (see PathFacts in src/core/paths/confine.ts).",
      forbiddenBinding:
        "src/core/ is pure: \"{{binding}}\" from \"{{specifier}}\" is not deterministic. Only {{allowed}} may be imported here.",
      wholeModule:
        "src/core/ may import \"{{specifier}}\" only by name ({{allowed}}), so a non-deterministic binding cannot slip in through the namespace.",
      forbiddenGlobal:
        "src/core/ is pure: \"{{name}}\" reads ambient state. Pass it in as an argument instead.",
      forbiddenClock:
        "src/core/ is pure: reading the clock here makes the result depend on when it ran. Take a `now` argument, the way GraphPorts does.",
      forbiddenRandom:
        "src/core/ is pure: randomness here makes the result unreproducible. Pass the value in.",
    },
  },
  create(context) {
    if (!relativeFilename(context).startsWith(CORE_PATH)) {
      return {};
    }

    const importVisitor = createImportVisitor((specifier, node) => {
      const builtin = builtinName(specifier);
      if (builtin === undefined) {
        return;
      }
      if (!ALLOWED_BUILTINS.has(builtin)) {
        context.report({ node, messageId: "forbiddenModule", data: { specifier } });
        return;
      }

      const allowed = ALLOWED_BUILTINS.get(builtin);
      if (allowed === null || allowed === undefined) {
        return;
      }
      const list = [...allowed].join(", ");

      // A partially-allowed module has to arrive as named imports. A default
      // or namespace import hands the whole surface over, random included.
      if (node.type !== "ImportDeclaration") {
        context.report({ node, messageId: "wholeModule", data: { specifier, allowed: list } });
        return;
      }
      for (const spec of node.specifiers) {
        if (spec.type !== "ImportSpecifier") {
          context.report({ node: spec, messageId: "wholeModule", data: { specifier, allowed: list } });
          continue;
        }
        const name = spec.imported.type === "Identifier" ? spec.imported.name : undefined;
        if (name === undefined || !allowed.has(name)) {
          context.report({
            node: spec,
            messageId: "forbiddenBinding",
            data: { binding: name ?? "?", specifier, allowed: list },
          });
        }
      }
    });

    return {
      ...importVisitor,

      /** @param {any} node */
      MemberExpression(node) {
        if (node.object.type === "Identifier" && FORBIDDEN_GLOBALS.has(node.object.name)) {
          context.report({ node, messageId: "forbiddenGlobal", data: { name: node.object.name } });
          return;
        }
        // `Date.now()` and `Math.random()` are the two that look harmless.
        if (node.object.type === "Identifier" && node.property.type === "Identifier") {
          if (node.object.name === "Date" && node.property.name === "now") {
            context.report({ node, messageId: "forbiddenClock" });
          }
          if (node.object.name === "Math" && node.property.name === "random") {
            context.report({ node, messageId: "forbiddenRandom" });
          }
        }
      },

      /** @param {any} node */
      NewExpression(node) {
        // `new Date()` reads the clock; `new Date("2026-01-01")` parses a
        // string and is deterministic. Only the first is a problem.
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "Date" &&
          node.arguments.length === 0
        ) {
          context.report({ node, messageId: "forbiddenClock" });
        }
      },
    };
  },
};

export default rule;
