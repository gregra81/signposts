import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule, { findExistingModule } from "../no-magic-literal.js";

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    parser: tsParser,
  },
});

const FIXTURE_CONSTANTS_MODULE = "eslint-rules/__tests__/fixtures/constants.ts";
const MISSING_CONSTANTS_MODULE = "eslint-rules/__tests__/fixtures/does-not-exist.ts";
const BROKEN_CONSTANTS_MODULE = "eslint-rules/__tests__/fixtures/broken-constants.ts.txt";

ruleTester.run("no-magic-literal", rule, {
  valid: [
    {
      // Outside src/, the rule doesn't apply at all.
      code: "const idleHours = 24;",
      filename: "eslint-rules/lib/some-helper.js",
      options: [{ constantsModule: FIXTURE_CONSTANTS_MODULE }],
    },
    {
      // The constants module itself is exempt from its own rule.
      code: "export const IDLE_HOURS = 24;",
      filename: FIXTURE_CONSTANTS_MODULE,
      options: [{ constantsModule: FIXTURE_CONSTANTS_MODULE }],
    },
    {
      // 0, 1, and "" are always exempt, even though they're not
      // literally exported by the fixture module by coincidence of
      // being common values.
      code: "const a = 0; const b = 1; const c = '';",
      filename: "src/core/eligibility/index.ts",
      options: [{ constantsModule: FIXTURE_CONSTANTS_MODULE }],
    },
    {
      // Strings under 4 chars are exempt, so TOKEN_PREFIXES-style short
      // prefixes don't false-positive on every literal in the codebase.
      code: 'const prefix = "sk-";',
      filename: "src/core/redact/index.ts",
      options: [{ constantsModule: FIXTURE_CONSTANTS_MODULE }],
    },
    {
      // Regex-valued constants are never collected, so a literal that
      // merely looks similar isn't affected.
      code: 'const notARegex = "(SECRET|TOKEN|PASSWORD)";',
      filename: "src/core/redact/index.ts",
      options: [{ constantsModule: FIXTURE_CONSTANTS_MODULE }],
    },
    {
      // Quiet when the configured constants module doesn't exist.
      code: "const idleHours = 24;",
      filename: "src/core/eligibility/index.ts",
      options: [{ constantsModule: MISSING_CONSTANTS_MODULE }],
    },
    {
      // Quiet with the default constants module path too, since it
      // doesn't exist yet in this repo (it lands in a later build step).
      code: "const idleHours = 24;",
      filename: "src/core/eligibility/index.ts",
    },
    {
      // A constants module that fails to parse (e.g. mid-edit, the
      // state a developer is actually in while adding a constant) must
      // not crash the rule — quiet, not an uncaught rule-load failure.
      code: "const idleHours = 24;",
      filename: "src/core/eligibility/index.ts",
      options: [{ constantsModule: BROKEN_CONSTANTS_MODULE }],
    },
    {
      // Object-property keys are not values duplicating a constant —
      // only flag it if it appears as a value.
      code: 'const byId = { "not-a-real-secret-value": 1 };',
      filename: "src/core/redact/index.ts",
      options: [{ constantsModule: FIXTURE_CONSTANTS_MODULE }],
    },
  ],
  invalid: [
    {
      // A duplicated numeric literal is exactly what the rule exists to
      // catch: re-tuning IDLE_HOURS should stay a one-line change in the
      // constants module.
      code: "export function isIdle(hoursSince: number) { return hoursSince >= 24; }",
      filename: "src/core/eligibility/index.ts",
      options: [{ constantsModule: FIXTURE_CONSTANTS_MODULE }],
      errors: [{ messageId: "duplicatesConstant" }],
    },
    {
      // A duplicated long string is caught too, not just numbers.
      code: 'const leaked = "not-a-real-secret-value";',
      filename: "src/core/redact/index.ts",
      options: [{ constantsModule: FIXTURE_CONSTANTS_MODULE }],
      errors: [{ messageId: "duplicatesConstant" }],
    },
  ],
});

// The default constants-module lookup is a small ordered list of
// candidate paths rather than one unverified guess, so a later change
// to where the constants module actually lands doesn't silently turn
// the rule into a permanent no-op. Tested directly, since RuleTester
// always exercises an explicit `constantsModule` option.
describe("no-magic-literal default candidate resolution", () => {
  const fixturesDir = fileURLToPath(new URL("./fixtures/", import.meta.url));

  it("picks the first candidate that exists on disk", () => {
    const found = findExistingModule(
      ["does-not-exist.ts", "constants.ts"],
      fixturesDir,
    );
    expect(found).toBe(fileURLToPath(new URL("./fixtures/constants.ts", import.meta.url)));
  });

  it("returns undefined when no candidate exists", () => {
    const found = findExistingModule(
      ["does-not-exist-a.ts", "does-not-exist-b.ts"],
      fixturesDir,
    );
    expect(found).toBeUndefined();
  });
});
