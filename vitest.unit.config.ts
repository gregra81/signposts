// Vitest config scoped to test/unit — what Stryker's test runner drives
// (see stryker.config.mjs). Deliberately narrower than the root
// vitest.config.ts: once test/behaviour/ lands (real SQLite, real git,
// real embeddings), Stryker re-running that suite once per mutant is
// the runtime explosion Tier 3 excludes io/ to avoid.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
  },
});
