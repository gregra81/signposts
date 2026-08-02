import { describe, it } from "vitest";
import { RuleTester } from "eslint";
import rule from "../no-src-import-in-hooks-or-statusline.js";

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
});

ruleTester.run("no-src-import-in-hooks-or-statusline", rule, {
  valid: [
    {
      code: 'import { thing } from "./local.js";',
      filename: "hooks/on-start.ts",
    },
    {
      code: 'import { core } from "../src/core/index.js";',
      filename: "src/core/index.ts",
    },
    {
      // The guarded-dir check must be anchored to the repo root; a
      // "hooks" segment nested inside src/ is not the guarded hooks/ dir.
      code: 'import { core } from "../../src/core/index.js";',
      filename: "src/core/hooks/inner2.ts",
    },
    {
      // Bare npm specifiers are never flagged, even ones that happen to
      // contain a "/src/" segment.
      code: 'import { thing } from "some-pkg/src/thing.js";',
      filename: "hooks/on-start.ts",
    },
  ],
  invalid: [
    {
      code: 'import { core } from "../src/core/index.js";',
      filename: "hooks/on-start.ts",
      errors: [{ messageId: "forbidden" }],
    },
    {
      code: 'import { core } from "../src/core/index.js";',
      filename: "statusline/render.ts",
      errors: [{ messageId: "forbidden" }],
    },
    {
      // "#"-prefixed subpath imports aliasing into src/ must be caught
      // too.
      code: 'import { core } from "#src/core/index.js";',
      filename: "hooks/on-start.ts",
      errors: [{ messageId: "forbidden" }],
    },
    {
      // The rule must fire on .js files under hooks/, not just .ts.
      code: 'import { core } from "../src/core/index.js";',
      filename: "hooks/on-start.js",
      errors: [{ messageId: "forbidden" }],
    },
    {
      // require() reaching into src/ must be caught too, not just static
      // import declarations.
      code: 'require("../src/core/index.js");',
      filename: "hooks/on-start.cjs",
      errors: [{ messageId: "forbidden" }],
    },
  ],
});
