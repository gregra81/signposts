// Local eslint plugin bundling signposts' custom rules.

import noAnthropicSdkOutsideIoModel from "./no-anthropic-sdk-outside-io-model.js";
import noIoInCore from "./no-io-in-core.js";
import noMagicLiteral from "./no-magic-literal.js";
import noSrcImportInHooksOrStatusline from "./no-src-import-in-hooks-or-statusline.js";

/** @type {import('eslint').ESLint.Plugin} */
const plugin = {
  rules: {
    "no-anthropic-sdk-outside-io-model": noAnthropicSdkOutsideIoModel,
    "no-io-in-core": noIoInCore,
    "no-magic-literal": noMagicLiteral,
    "no-src-import-in-hooks-or-statusline": noSrcImportInHooksOrStatusline,
  },
};

export default plugin;
