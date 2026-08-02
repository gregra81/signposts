import { describe, it } from "vitest";
import { RuleTester } from "eslint";
import rule from "../no-anthropic-sdk-outside-io-model.js";

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
});

ruleTester.run("no-anthropic-sdk-outside-io-model", rule, {
  valid: [
    {
      code: 'import Anthropic from "@anthropic-ai/sdk";',
      filename: "src/io/model/client.ts",
    },
    {
      code: 'import { something } from "./local.js";',
      filename: "src/core/index.ts",
    },
    {
      // Subpath imports are sanctioned too, as long as the file is under
      // src/io/model/.
      code: 'import { Messages } from "@anthropic-ai/sdk/resources/messages";',
      filename: "src/io/model/client.ts",
    },
  ],
  invalid: [
    {
      code: 'import Anthropic from "@anthropic-ai/sdk";',
      filename: "src/core/index.ts",
      errors: [{ messageId: "forbidden" }],
    },
    {
      // Subpath imports of the SDK must be caught too, not just the bare
      // specifier.
      code: 'import { Messages } from "@anthropic-ai/sdk/resources/messages";',
      filename: "src/core/index.ts",
      errors: [{ messageId: "forbidden" }],
    },
    {
      // The sanctioned-path check must be anchored to the repo root, not
      // an unanchored substring match, so a "src/io/model/" segment deep
      // inside another tree doesn't act as an escape hatch.
      code: 'import Anthropic from "@anthropic-ai/sdk";',
      filename: "statusline/src/io/model/leak.ts",
      errors: [{ messageId: "forbidden" }],
    },
    {
      // Dynamic import() of the SDK must be caught, not just static
      // import declarations.
      code: 'import("@anthropic-ai/sdk");',
      filename: "src/core/index.ts",
      errors: [{ messageId: "forbidden" }],
    },
    {
      // require() of the SDK must be caught too.
      code: 'require("@anthropic-ai/sdk");',
      filename: "src/core/index.ts",
      errors: [{ messageId: "forbidden" }],
    },
  ],
});
