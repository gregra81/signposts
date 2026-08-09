// Table-driven unit tests for the redactor (15-spec.md #16/#17,
// 02-ingestion.md "Redaction", 16-build-plan.md Tier 1 #2).

import { describe, expect, it } from "vitest";
import { redact, safeRedact, defaultRedactors } from "../../../src/core/redact/redact.js";
import { TOKEN_PREFIXES, SECRET_KEY_NAME_RE, ENTROPY_MIN_LEN } from "../../../src/core/config/constants.js";

describe("redact", () => {
  const cases: Array<{ name: string; kind: string; before: string; secret: string }> = [
    {
      name: "an AWS access key prefix",
      kind: "token",
      before: "the key is ",
      secret: "AKIAIOSFODNN7EXAMPLE",
    },
    {
      // ANTHROPIC_API_KEY matches SECRET_KEY_NAME_RE, so the env-secret
      // stage (which runs before the token stage) claims this one first —
      // same secret, more informative kind (which variable held it).
      name: "an Anthropic API key prefix assigned to an env-style key",
      kind: "env-secret",
      before: "export ANTHROPIC_API_KEY=",
      secret: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
    },
    {
      name: "an Anthropic API key prefix on its own, no key name",
      kind: "token",
      before: "the key is ",
      secret: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
    },
    {
      name: "a GitHub personal access token prefix",
      kind: "token",
      before: "token: ",
      secret: "ghp_1234567890abcdefghijklmnopqrstuvwxyz",
    },
    {
      name: "a Slack token prefix (the bracketed alternation prefix)",
      kind: "token",
      before: "slack token ",
      secret: "xoxb-1234567890-abcdefghijklmnopqrstuvwxyz",
    },
    {
      name: "a bearer token in an Authorization header",
      kind: "token",
      before: "Authorization: ",
      secret: "Bearer abc123DEF456ghi789JKL012mno345",
    },
    {
      name: "a private key block",
      kind: "private-key",
      before: "here is the key:\n",
      secret:
        "-----BEGIN RSA PRIVATE KEY-----\n" +
        "MIIEpAIBAAKCAQEA1c7+9z5Pad7OejecsQ0bu3aumgSFxmSNE0Ug\n" +
        "-----END RSA PRIVATE KEY-----",
    },
    {
      name: "a credentialed postgres connection string",
      kind: "connection-string",
      before: "DATABASE_URL=",
      secret: "postgres://dbuser:sup3rSecr3t@db.example.com:5432/prod",
    },
    {
      name: "a credentialed mongodb connection string",
      kind: "connection-string",
      before: "connect to ",
      secret: "mongodb://root:hunter2@cluster0.example.net/mydb",
    },
    {
      name: "an .env-style secret line by key name",
      kind: "env-secret",
      before: "",
      secret: "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY",
    },
    {
      name: "a generic high-entropy blob",
      kind: "high-entropy",
      before: "blob: ",
      secret: "Zm9vYmFyYmF6cXV1eGNvcmdlZ3JhdWx0Z2FybHlmbG9vcA==",
    },
  ];

  for (const { name, kind, before, secret } of cases) {
    it(`replaces ${name} with a [REDACTED:${kind}] placeholder`, () => {
      const input = `${before}${secret} after`;
      const output = redact(input);
      expect(output).not.toContain(secret);
      expect(output).toContain(`[REDACTED:${kind}]`);
    });
  }

  it("never deletes the surrounding text, only the secret span", () => {
    const input = "before-marker AKIAIOSFODNN7EXAMPLE after-marker";
    const output = redact(input);
    expect(output).toContain("before-marker");
    expect(output).toContain("after-marker");
  });

  it("preserves the .env key name, redacting only the value", () => {
    const output = redact("API_TOKEN=verysecretvalue1234567890");
    expect(output).toContain("API_TOKEN=");
    expect(output).not.toContain("verysecretvalue1234567890");
  });

  it("leaves an .env line with a non-secret key name untouched", () => {
    const output = redact("DATABASE_HOST=db.internal.example.com");
    expect(output).toBe("DATABASE_HOST=db.internal.example.com");
  });

  it("leaves plain prose with no secrets unchanged", () => {
    const text = "We decided to use SQLite for the local mirror because it needs no server.";
    expect(redact(text)).toBe(text);
  });

  it("redacts multiple distinct secrets in the same text, each independently", () => {
    const output = redact("key one AKIAIOSFODNN7EXAMPLE and key two ghp_1234567890abcdefghijklmnopqrstuvwxyz");
    expect(output).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(output).not.toContain("ghp_1234567890abcdefghijklmnopqrstuvwxyz");
  });

  it("redacts two tokens sharing the same prefix in one text, not just the first", () => {
    const output = redact("first AKIAAAAAAAAAAAAAAAAA and second AKIABBBBBBBBBBBBBBBBB");
    expect(output).not.toContain("AKIAAAAAAAAAAAAAAAAA");
    expect(output).not.toContain("AKIABBBBBBBBBBBBBBBBB");
  });

  it("redacts a connection string with no path/query/fragment at all (bare host)", () => {
    const output = redact("try postgres://dbuser:dbpass@dbhost after");
    expect(output).toBe("try [REDACTED:connection-string] after");
  });

  it("redacts two distinct high-entropy blobs in the same text, not just the first", () => {
    const output = redact(
      "aA0aA0aA0aA0aA0aA0aA0aA0aA0aA0aA and then bB1bB1bB1bB1bB1bB1bB1bB1bB1bB1bB",
    );
    expect(output).not.toContain("aA0aA0aA0aA0aA0aA0aA0aA0aA0aA0aA");
    expect(output).not.toContain("bB1bB1bB1bB1bB1bB1bB1bB1bB1bB1bB");
  });

  it("consumes a connection string's trailing slash and nothing past it, leaving the rest of the sentence intact", () => {
    const output = redact("try mysql://dbuser:dbpass@dbhost/ after");
    expect(output).toBe("try [REDACTED:connection-string] after");
  });

  it("redacts an env-secret value even when spaced out around the '=' (KEY = value)", () => {
    const output = redact("SECRET_KEY = abc123def456");
    expect(output).not.toContain("abc123def456");
    expect(output).toContain("[REDACTED:env-secret]");
  });

  it("redacts the full env-secret value, not just its first character", () => {
    const output = redact("SECRET_KEY=abc123def456xyz");
    expect(output).not.toContain("bc123def456xyz");
  });

  it("requires the run of whitespace after 'Bearer', not just one char, before treating the rest as the token", () => {
    const output = redact("Authorization: Bearer  supersecrettoken123456");
    expect(output).not.toContain("supersecrettoken123456");
  });

  it("redacts the full bearer token, not just its first character", () => {
    const output = redact("Authorization: Bearer supersecrettoken123456");
    expect(output).not.toContain("upersecrettoken123456");
  });

  it("sourced its prefix list from TOKEN_PREFIXES, not a private copy", () => {
    // Sanity check that the fixture set above actually exercises the shared
    // constant rather than a hand-duplicated list drifting from it.
    expect(TOKEN_PREFIXES).toContain("AKIA");
    expect(TOKEN_PREFIXES).toContain("ghp_");
  });

  it("sourced its secret-key-name check from SECRET_KEY_NAME_RE", () => {
    expect(SECRET_KEY_NAME_RE.test("AWS_SECRET_ACCESS_KEY")).toBe(true);
    expect(SECRET_KEY_NAME_RE.test("DATABASE_HOST")).toBe(false);
  });

  it("sourced its entropy floor from ENTROPY_MIN_LEN", () => {
    const short = "a".repeat(ENTROPY_MIN_LEN - 1);
    const long = "aB3xQ7mN9pR2sT5vW8yZ1cE4gJ6kM0oQ".slice(0, ENTROPY_MIN_LEN);
    expect(redact(`blob ${short} end`)).toContain(short);
    expect(redact(`blob ${long} end`)).not.toContain(long);
  });

  it("is idempotent on a fixed example: redacting an already-redacted text changes nothing further", () => {
    const once = redact("key: AKIAIOSFODNN7EXAMPLE");
    const twice = redact(once);
    expect(twice).toBe(once);
  });
});

describe("safeRedact — fail-closed on an internal error (FAIL_MODE=closed, 15-spec.md #17)", () => {
  it("returns ok:true with the redacted text on success", () => {
    const result = safeRedact("no secrets here");
    expect(result).toEqual({ ok: true, text: "no secrets here" });
  });

  it("returns ok:false, never the raw text, when a redactor throws", () => {
    const throwing = () => {
      throw new Error("boom: pattern engine exploded");
    };
    const result = safeRedact("some SECRET_TOKEN=abc123 text", [...defaultRedactors(), throwing]);
    expect(result).toEqual({ ok: false });
  });

  it("does not fall through to unredacted text when the throwing matcher runs first", () => {
    const throwing = () => {
      throw new Error("boom");
    };
    const result = safeRedact("SECRET_TOKEN=abc123", [throwing, ...defaultRedactors()]);
    expect(result).toEqual({ ok: false });
  });
});

describe("redact (unwrapped) — propagates rather than swallows, so callers must opt into safeRedact", () => {
  it("throws when a redactor throws, instead of returning the input", () => {
    const throwing = () => {
      throw new Error("boom");
    };
    expect(() => redact("text", [throwing])).toThrow("boom");
  });
});
