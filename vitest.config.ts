import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "eslint-rules/**/*.test.ts"],
    // Downloads the embedding model once if it is missing, so the suite runs
    // with the network off. See test/support/model-cache.ts.
    globalSetup: ["test/support/global-setup.ts"],
  },
});
