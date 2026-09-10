// @ts-check
// Compiles src/ into dist/ for distribution (18-end-to-end-gaps.md, item 9).
//
// The repo needs no build. Node 24 strips types natively, so `bin/signpost.js`
// imports `src/io/production-app.ts` and everything below it carries `.ts` on
// its relative specifiers, because that is the file that exists at runtime.
// 07-triggering-and-ux.md drew the conclusion that the CLI therefore needs no
// build step, and the first half is true while the conclusion is not: Node
// refuses to strip types beneath `node_modules`.
//
//   Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is
//   currently unsupported for files under node_modules, for
//   ".../signposts/src/io/production-app.ts"
//
// So `init`, `index`, `doctor`, `run`, `resume`, `worker` and `mcp` were all
// dead on an installed copy — and quietly, because the two things that did
// work are the two bundles the no-src-import rule was for. The hook woke, took
// the run lock, and spawned a worker that died at import with its stderr going
// to /dev/null, leaving the lock to sit for LOCK_STALE_MINUTES.
//
// Two jobs, and the second is the one that is easy to forget: strip the types,
// and rewrite every relative `.ts` specifier to `.js`. The extension is not
// cosmetic — it is what makes the checkout runnable without a build today, and
// it names a file that does not exist in `dist/`.
//
// Same `mode: "strip"` as scripts/build-hooks.mjs, so line numbers in a stack
// trace still point at the `.ts` they came from.

import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SOURCE = path.join(ROOT, "src");
const OUTPUT = path.join(ROOT, "dist");

/**
 * Rewrites relative `.ts` specifiers to `.js`.
 *
 * Only relative ones: a bare specifier is a package, and `node:fs` is a
 * builtin. Both `import`/`export ... from "..."` forms are covered by matching
 * the quoted specifier after `from`, which is the only shape this codebase
 * uses — there is no dynamic `import()` of a source file anywhere in `src/`,
 * and `import("node:fs")` in a type position is erased before this runs.
 *
 * @param {string} code
 * @returns {string}
 */
function rewriteSpecifiers(code) {
  return code.replace(/(\sfrom\s*")(\.[^"]*)\.ts(")/g, "$1$2.js$3");
}

/** @param {string} directory */
function build(directory) {
  const relative = path.relative(SOURCE, directory);
  mkdirSync(path.join(OUTPUT, relative), { recursive: true });

  let count = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const from = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      count += build(from);
      continue;
    }
    if (entry.name.endsWith(".ts")) {
      const stripped = stripTypeScriptTypes(readFileSync(from, "utf8"), { mode: "strip" });
      writeFileSync(path.join(OUTPUT, relative, entry.name.replace(/\.ts$/, ".js")), rewriteSpecifiers(stripped));
      count += 1;
      continue;
    }
    // Anything else in src/ travels as-is. There is nothing today; a JSON
    // fixture or a .sql file added later should not silently go missing.
    cpSync(from, path.join(OUTPUT, relative, entry.name));
  }
  return count;
}

rmSync(OUTPUT, { recursive: true, force: true });
const built = build(SOURCE);
console.log(`dist/: ${String(built)} modules`);
