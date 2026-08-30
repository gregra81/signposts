// What Stryker's test runner drives (see stryker.config.mjs): test/unit,
// plus test/behaviour/graph.
//
// Narrower than the root vitest.config.ts, and the line is drawn at cost,
// not at directory. A behaviour suite on real git and real embeddings re-run
// once per mutant is the runtime explosion Tier 3 excludes io/ to avoid.
// test/behaviour/graph is not that: it runs on hand-written fakes, three of
// its four files on MemorySaver, and it is the only coverage src/graph has —
// without it every mutant there scores NoCoverage.
//
// interrupt.test.ts is the exception, and deliberately so: an interrupt that
// only survives inside one process is not the thing being tested, so it uses
// the real SqliteSaver on a temp directory. It closes every connection it
// opens, which is what keeps its cost a per-test file open rather than a leak
// that grows across the run.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts", "test/behaviour/graph/**/*.test.ts"],
    // Stryker spawns a Vitest process per mutant batch, and a mutant is
    // meant to fail a test — that's the kill. Vitest's github-actions
    // reporter would otherwise post one job-summary block per spawn, each
    // showing that expected failure as if it were a real CI break.
    reporters:
      process.env.GITHUB_ACTIONS === "true"
        ? [["github-actions", { jobSummary: { enabled: false } }]]
        : ["default"],
  },
});
