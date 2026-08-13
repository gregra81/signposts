// Pattern-driven redactors, one per row of 02-ingestion.md's "minimum
// viable redaction" list. Each is a pure text -> text pass; composed in
// redact.ts.
//
// Every regex is built inside its Redactor's function body, not as a
// module-level const. stryker.config.mjs sets ignoreStatic: true, which
// treats a top-level `const RE = /.../ ` as evaluated once at import and
// excludes its mutants from scoring entirely (neither killed nor
// survived) — exactly the "100% score, zero actual coverage" trap
// 16-build-plan.md's Tier 3 section warns about for "a module that is
// mostly security regexes". Building each regex per call keeps every
// pattern mutation-testable.

import { ENTROPY_MIN_LEN, SECRET_KEY_NAME_RE, TOKEN_PREFIXES } from "../config/constants.ts";
import { placeholderFor } from "./types.ts";
import type { Redactor } from "./types.ts";

/** `-----BEGIN * PRIVATE KEY-----` ... `-----END * PRIVATE KEY-----`, whole block. */
export const redactPrivateKeys: Redactor = (text) => {
  const privateKeyRe = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
  return text.replace(privateKeyRe, placeholderFor("private-key"));
};

/**
 * scheme://user:pass@host[/path] — only when credentials are embedded.
 * A bare `postgres://host/db` with no `user:pass@` is not a secret and is
 * left alone. No leading `\b`: the scheme's char class already requires a
 * letter to start, so a digit glued directly in front (no boundary) still
 * can't merge into it — same reasoning as BEARER_RE below.
 */
export const redactConnectionStrings: Redactor = (text) => {
  const connectionStringRe = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@[^\s/?#]+(?:[/?#]\S*)?/g;
  return text.replace(connectionStringRe, placeholderFor("connection-string"));
};

/**
 * `.env`-style `KEY=value` assignments where the key name matches
 * SECRET_KEY_NAME_RE. Keeps `KEY=` visible, replaces only the value, so a
 * claim that depends on which variable held a secret stays legible.
 *
 * No line-start anchor: an assignment glued directly onto preceding
 * non-word text (no newline in between) is still an assignment, and
 * anchoring on line-start alone missed it. No boundary is needed on the
 * left either — `[A-Za-z_]` can't start mid-identifier, so the engine's
 * leftmost-match rule already finds the identifier's true start (e.g. in
 * "0API_SECRET=x" it skips the non-word-starting "0" and matches
 * "API_SECRET" as the key, not a truncated piece of a larger one).
 */
export const redactEnvSecrets: Redactor = (text) => {
  const envLineRe = /([A-Za-z_][A-Za-z0-9_]*)([ \t]*=[ \t]*)(\S+)/g;
  return text.replace(envLineRe, (match, key: string, equals: string) =>
    SECRET_KEY_NAME_RE.test(key) ? `${key}${equals}${placeholderFor("env-secret")}` : match,
  );
};

/**
 * TOKEN_PREFIXES joined into one alternation. Not escaped: 13-constants.md
 * lists `xox[baprs]-` as a regex fragment (a bracket class covering the
 * Slack token family), not a literal string, so this module honours it as
 * one — the other entries have no regex metacharacters, so joining them
 * unescaped is equivalent to joining them escaped. No length-sort of the
 * prefixes: the trailing body class already consumes hyphens and letters
 * past any prefix, so which of two overlapping prefixes (e.g. `sk-` vs
 * `sk-ant-`) matches first never changes the matched span or its kind —
 * sorting would be complexity with no observable effect.
 *
 * Also covers `Authorization: Bearer <opaque-token>` and similar
 * bearer-scheme headers. No leading `\b` on that one: `\b` needs a
 * word/non-word transition, which a fuzzed input can defeat by butting
 * another word character straight up against "Bearer" (e.g. "0Bearer
 * token") — the keyword itself is distinctive enough not to need one.
 */
export const redactTokens: Redactor = (text) => {
  const tokenPrefixAlternation = TOKEN_PREFIXES.join("|");
  const tokenPrefixRe = new RegExp(`(?:${tokenPrefixAlternation})[A-Za-z0-9_./+=-]*`, "g");
  const bearerRe = /Bearer\s+[A-Za-z0-9._~+/-]+=*/g;
  return text.replace(tokenPrefixRe, placeholderFor("token")).replace(bearerRe, placeholderFor("token"));
};

/**
 * Generic high-entropy strings: ENTROPY_MIN_LEN+ contiguous base64/hex-set
 * characters. No boundary lookarounds — a quantified character class is
 * already greedy and already starts at the earliest position that can
 * begin a match, so an explicit boundary assertion adds nothing but a way
 * to misfire: an optional trailing `={0,2}` combined with a lookahead
 * that also excluded `=` could reject every possible match length when a
 * stray `=` happened to sit right after the run (the padding-vs-not
 * ambiguity had no length at which both the group and the lookahead were
 * simultaneously satisfiable).
 */
export const redactHighEntropy: Redactor = (text) => {
  const highEntropyRe = new RegExp(`[A-Za-z0-9+/]{${ENTROPY_MIN_LEN},}={0,2}`, "g");
  return text.replace(highEntropyRe, placeholderFor("high-entropy"));
};
