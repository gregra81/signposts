// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: "pnpm",
  plugins: [
    "@stryker-mutator/vitest-runner",
    "@stryker-mutator/typescript-checker",
  ],
  testRunner: "vitest",
  checkers: ["typescript"],
  tsconfigFile: "tsconfig.json",
  mutate: ["src/core/**/*.ts", "!src/core/**/*.test.ts"],
  // json feeds scripts/mutation-gate.mjs, which enforces the per-module break
  // thresholds that a single global `thresholds.break` cannot express.
  reporters: ["clear-text", "progress", "json"],
  coverageAnalysis: "perTest",
  vitest: {
    configFile: "vitest.unit.config.ts",
    related: false,
  },
  incremental: true,
  thresholds: { high: 90, low: 80, break: 80 },
  ignoreStatic: true,
};
