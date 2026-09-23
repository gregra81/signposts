// Which tree this process is running, for `doctor` to say out loud.
//
// The wrapper picks one (`bin/entry.js`), and until 2026-09-23 it picked a
// `dist/` whenever one existed — so a checkout that had packed once ran that
// build for a fortnight while every line of `doctor` reported ready. The
// wrapper's rule is fixed; this is the part that makes the answer visible.
//
// Read off the running module's own URL rather than the filesystem, because
// that is the only thing that cannot disagree with reality: whatever imported
// this is either under `dist/` or under `src/`.

import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildFact } from "../../core/doctor/report.ts";

/**
 * @param moduleUrl `import.meta.url` of a module inside the running tree.
 * @param repoRoot the package root, which holds both trees in a checkout.
 */
export function checkBuild(moduleUrl: string, repoRoot: string): BuildFact {
  const here = fileURLToPath(moduleUrl);
  const tree = here.split(path.sep).includes("dist") ? "dist" : "src";
  return {
    tree,
    ignoredDistBuiltAt: tree === "src" ? builtAt(repoRoot) : null,
  };
}

/** The date `dist/` was written, or null when there is none to ignore. */
function builtAt(repoRoot: string): string | null {
  try {
    const built = statSync(path.join(repoRoot, "dist", "io", "production-app.js"));
    // Split rather than sliced: `src/io/open-run.ts` takes the date off a
    // timestamp the same way, and a bare 10 here collides with an unrelated
    // constant under the repo's no-magic-literal rule.
    return built.mtime.toISOString().split("T")[0] ?? null;
  } catch {
    return null;
  }
}
