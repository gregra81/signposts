// Vitest config scoped to test/unit — what Stryker's test runner drives
// (see stryker.config.mjs). Deliberately narrower than the root
// vitest.config.ts: once test/behaviour/ lands (real SQLite, real git,
// real embeddings), Stryker re-running that suite once per mutant is
// the runtime explosion Tier 3 excludes io/ to avoid.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
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
