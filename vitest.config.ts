import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "eslint-rules/**/*.test.ts"],
    // Downloads the embedding model once if it is missing, so the suite runs
    // with the network off. See test/support/model-cache.ts.
    globalSetup: ["test/support/global-setup.ts"],
    // The mod sets SIGNPOSTS_MOD for everything a session starts, this suite
    // included, and the hook and statusLine tests spawn with process.env. A
    // test that wants the mod's path sets it itself.
    env: { SIGNPOSTS_MOD: "" },
  },
});
