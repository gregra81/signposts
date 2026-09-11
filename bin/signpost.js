#!/usr/bin/env node
// Wrapper (R6, 15-spec.md D1): argv + production ports, nothing else. Nothing
// else in the codebase constructs a port.
//
// The one branch is the two layouts this file has to start from. In a checkout
// there is no build and the modules are `src/**/*.ts`, which Node strips at
// startup. Under `node_modules` it refuses to strip anything, so an installed
// copy runs `dist/`, which `prepack` compiles with `tsconfig.build.json` — see
// 18-end-to-end-gaps.md item 9 for what an installed copy did before it
// existed: nothing, quietly.
//
// `dist/` first for the reason above, not because `src/` is absent — the
// tarball ships both, because a consumer running through `tsx` imports `src/`
// directly (CLAUDE.md, "Language and imports"). In a checkout that has built,
// both are here and either would work; the built one skips type stripping.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const built = path.join(root, "dist", "io", "production-app.js");
const source = path.join(root, "src", "io", "production-app.ts");

const entry = [built, source].find((candidate) => existsSync(candidate));
if (entry === undefined) {
  process.stderr.write(
    `signposts: neither ${path.relative(root, built)} nor ${path.relative(root, source)} is here. ` +
      "An installed copy is missing its build; a clone needs `pnpm install && pnpm build`.\n",
  );
  process.exit(1);
}

const { buildProductionApp } = await import(pathToFileURL(entry).href);
process.exitCode = await buildProductionApp().run(process.argv.slice(2));
