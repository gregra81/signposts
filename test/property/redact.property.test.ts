// Tier 2 property tests for the redactor (16-build-plan.md P3, P4, and
// the throwing-matcher fail-closed case).

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { redact, safeRedact, defaultRedactors } from "../../src/core/redact/redact.js";
import { TOKEN_PREFIXES } from "../../src/core/config/constants.js";

const bodyArb = fc.stringMatching(/^[A-Za-z0-9]{20,60}$/);

/**
 * Env-secret values use a longer floor than the other categories,
 * deliberately >= ENTROPY_MIN_LEN. redactEnvSecrets recognises `KEY=value`
 * by parsing left-to-right; an adversarial `before` can glue on its own
 * leading identifier+`=` (e.g. "A=API_SECRET=<value>"), which reparses the
 * whole thing as ONE assignment (key "A") that doesn't match
 * SECRET_KEY_NAME_RE — a correct parse of that string, not a bug. What
 * makes this safe regardless is the layered pipeline: redactHighEntropy
 * runs after redactEnvSecrets and catches any run this long independently
 * of key names or assignment syntax, so the value must be long enough for
 * that backstop to apply — same as it would need to be in production.
 */
const envSecretValueArb = fc.stringMatching(/^[A-Za-z0-9]{32,60}$/);

/**
 * One secret-shaped fixture per redacted category: `embed` is what gets
 * spliced into surrounding text, `secret` is the sensitive substring that
 * must not survive. For most categories the whole embed is sensitive; for
 * env-secret, the key name (`API_SECRET=`) is deliberately preserved
 * (patterns.ts's redactEnvSecrets keeps `KEY=` visible), so only the value
 * is the part P4 must never see leak back out.
 */
const secretFixtureArb = fc.oneof(
  fc
    .tuple(fc.constantFrom(...TOKEN_PREFIXES.filter((p) => !p.includes("["))), bodyArb)
    .map(([prefix, body]) => ({ embed: `${prefix}${body}`, secret: `${prefix}${body}` })),
  bodyArb.map((body) => ({ embed: `Bearer ${body}`, secret: `Bearer ${body}` })),
  fc
    .tuple(bodyArb, bodyArb)
    .map(([a, b]) => {
      const block = `-----BEGIN RSA PRIVATE KEY-----\n${a}\n${b}\n-----END RSA PRIVATE KEY-----`;
      return { embed: block, secret: block };
    }),
  fc
    .tuple(fc.constantFrom("postgres", "mongodb", "mysql", "redis"), bodyArb, bodyArb, bodyArb)
    .map(([scheme, user, pass, host]) => {
      const conn = `${scheme}://${user}:${pass}@${host}.example.com/db`;
      return { embed: conn, secret: conn };
    }),
  fc
    .tuple(fc.constantFrom("API_SECRET", "DB_PASSWORD", "AUTH_TOKEN", "MY_CREDENTIAL"), envSecretValueArb)
    .map(([key, value]) => ({ embed: `${key}=${value}`, secret: value })),
  bodyArb.map((body) => {
    const blob = body + body; // >= 40 chars of base64-ish charset, well past ENTROPY_MIN_LEN
    return { embed: blob, secret: blob };
  }),
);

const surroundingArb = fc.string({ maxLength: 30 });

describe("redact property tests", () => {
  it("P3: redaction is idempotent — redact(redact(x)) === redact(x)", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), surroundingArb), (text) => {
        const once = redact(text);
        const twice = redact(once);
        expect(twice).toBe(once);
      }),
    );
  });

  it("P3: idempotent on secrets embedded in surrounding text", () => {
    fc.assert(
      fc.property(surroundingArb, secretFixtureArb, surroundingArb, (before, { embed }, after) => {
        const once = redact(`${before}${embed}${after}`);
        const twice = redact(once);
        expect(twice).toBe(once);
      }),
    );
  });

  it("P4: no substring of an injected secret survives redaction anywhere in the output", () => {
    fc.assert(
      fc.property(surroundingArb, secretFixtureArb, surroundingArb, (before, { embed, secret }, after) => {
        const output = redact(`${before}${embed}${after}`);
        const windowSize = Math.min(8, secret.length);
        for (let start = 0; start + windowSize <= secret.length; start++) {
          const window = secret.slice(start, start + windowSize);
          // Windows entirely made of separator/structural characters (e.g.
          // "-----BEG" is fine to flag, but a window that is just "\n\n\n\n"
          // or all-'=' padding is not a meaningful secret fragment).
          if (/[A-Za-z0-9]/.test(window) === false) continue;
          expect(output.includes(window)).toBe(false);
        }
      }),
    );
  });

  it("a throwing matcher causes safeRedact to skip (ok:false), never a fallthrough to raw text", () => {
    fc.assert(
      fc.property(fc.string(), fc.nat({ max: defaultRedactors().length }), (text, position) => {
        const throwing = () => {
          throw new Error("injected matcher failure");
        };
        const redactors = [...defaultRedactors().slice(0, position), throwing, ...defaultRedactors().slice(position)];
        const result = safeRedact(text, redactors);
        expect(result).toEqual({ ok: false });
      }),
    );
  });
});
