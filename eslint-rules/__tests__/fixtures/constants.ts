// Fixture constants module for no-magic-literal.test.ts. Shaped after
// 13-constants.md: flat scalars, an array of short strings, and a
// regex — not the real constants module, which doesn't exist yet.

export const IDLE_HOURS = 24;
export const LONG_TOKEN_PLACEHOLDER = "not-a-real-secret-value";
export const ZERO = 0;
export const ONE = 1;
export const EMPTY_STRING = "";
export const SECRET_KEY_NAME_RE = /(SECRET|TOKEN|PASSWORD)/i;
export const TOKEN_PREFIXES = ["sk-", "AKIA"];
