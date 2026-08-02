import { describe, it } from "vitest";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "../no-self-named-constant.js";

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    // `as const` in the test cases below is TS syntax; the default
    // espree parser can't handle it.
    parser: tsParser,
  },
});

ruleTester.run("no-self-named-constant", rule, {
  valid: [
    {
      code: 'export const FOO = "the actual value";',
      filename: "src/core/constants.ts",
    },
    {
      // Same self-naming pattern, but outside a constants module.
      code: 'export const FOO = "FOO";',
      filename: "src/core/index.ts",
    },
    {
      // Case-insensitive, but punctuation is not stripped: "Foo!" does
      // not duplicate "FOO".
      code: 'export const FOO = "Foo!";',
      filename: "src/core/constants.ts",
    },
  ],
  invalid: [
    {
      code: 'export const FOO = "FOO";',
      filename: "src/core/constants.ts",
      errors: [{ messageId: "selfNamed" }],
    },
    {
      code: 'export const FOO = "foo";',
      filename: "src/core/constants/errors.ts",
      errors: [{ messageId: "selfNamed" }],
    },
    {
      // `as const` is the default idiom for a constants module and must
      // be unwrapped before the literal check.
      code: 'export const FOO = "FOO" as const;',
      filename: "src/core/constants.ts",
      errors: [{ messageId: "selfNamed" }],
    },
    {
      // A no-expression template literal is equivalent to a string
      // literal for this rule.
      code: "export const FOO = `FOO`;",
      filename: "src/core/constants.ts",
      errors: [{ messageId: "selfNamed" }],
    },
    {
      // Nested directories under constants/ are still constants modules.
      code: 'export const BAR = "bar";',
      filename: "src/core/constants/nested/deep.ts",
      errors: [{ messageId: "selfNamed" }],
    },
  ],
});
