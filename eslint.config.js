// Flat eslint config. Wires up typescript-eslint plus the local
// signposts eslint plugin (eslint-rules/).

import tseslint from "typescript-eslint";
import signposts from "./eslint-rules/index.js";

export default tseslint.config(
  {
    ignores: ["node_modules/**", "dist/**", ".stryker-tmp/**"],
  },
  tseslint.configs.base,
  {
    files: ["**/*.{ts,tsx,mts,cts,js,mjs,cjs}"],
    plugins: {
      signposts,
    },
    rules: {
      "signposts/no-io-in-core": "error",
      "signposts/no-magic-literal": "error",
      "signposts/no-src-import-in-hooks-or-statusline": "error",
    },
  },
);
