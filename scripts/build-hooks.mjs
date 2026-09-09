// @ts-check
// Compiles hooks/ from TypeScript to the `.js` files that
// ship (07-triggering-and-ux.md, "Distribution: a Claude Code plugin").
//
// Both directories are standalone zero-dependency bundles — they import
// nothing but `node:` builtins, enforced by
// eslint-rules/no-src-import-in-hooks-or-statusline.js — so "compiling" them
// is type stripping and nothing else. No bundler, and no `dist/`: the output
// sits beside its source, which is what the plugin manifest points at.
//
// Node 24 can strip types at startup, but the hook ships pre-compiled anyway.
// Stripping is parse work paid on every session start, and HOOK_BUDGET_MS has
// no room for it — see scripts/measure-hook.mjs for what that costs measured.
//
// `stripTypeScriptTypes` in `mode: "strip"` replaces types with whitespace
// rather than removing them, so a stack trace from the shipped `.js` points at
// the same line as the `.ts` it came from.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// statusline/ joins this list when it grows past its placeholder.
const DIRECTORIES = ["hooks"];

const built = [];
for (const directory of DIRECTORIES) {
  const absolute = path.join(ROOT, directory);
  for (const entry of readdirSync(absolute)) {
    if (!entry.endsWith(".ts")) {
      continue;
    }
    const source = path.join(absolute, entry);
    const output = source.replace(/\.ts$/, ".js");
    writeFileSync(output, stripTypeScriptTypes(readFileSync(source, "utf8"), { mode: "strip" }));
    built.push(path.relative(ROOT, output));
  }
}

console.log(built.length === 0 ? "nothing to build" : built.join("\n"));
