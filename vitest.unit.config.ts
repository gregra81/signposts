// What Stryker's test runner drives (see stryker.config.mjs): test/unit,
// plus test/behaviour/graph.
//
// Narrower than the root vitest.config.ts, and the line is drawn at cost,
// not at directory. A behaviour suite on real SQLite, real git and real
// embeddings re-run once per mutant is the runtime explosion Tier 3 excludes
// io/ to avoid. test/behaviour/graph is not that: it runs on MemorySaver and
// hand-written fakes, and it is the only coverage src/graph has — without it
// every mutant there scores NoCoverage.
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
