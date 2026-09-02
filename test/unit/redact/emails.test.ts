// Email pseudonymisation — 02-ingestion.md's fifth redaction row, and the
// one that was missing while the other four shipped. The properties that
// matter are stability (same person, same pseudonym, across sessions) and
// separation (same person, different repo, different pseudonym): a signpost
// is only useful if the model can follow who said what, and only safe if the
// pseudonym says nothing about the address outside this repo.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { redactEmails } from "../../../src/core/redact/patterns.js";
import { redact, wireRedactors } from "../../../src/core/redact/redact.js";
import { AUTHOR_PSEUDONYM_PREFIX } from "../../../src/core/config/constants.js";

const REPO_ROOT = "/Users/dev/Projects/platform";
const OTHER_REPO_ROOT = "/Users/dev/Projects/other";

const pseudonymRe = new RegExp(`^${AUTHOR_PSEUDONYM_PREFIX}[0-9a-f]{4}$`);

describe("redactEmails", () => {
  it("replaces an address with a pseudonym and leaves the sentence around it", () => {
    const output = redactEmails(REPO_ROOT)("ask dana@acme.example about the migration");

    expect(output).not.toContain("dana@acme.example");
    expect(output).toMatch(/^ask author-[0-9a-f]{4} about the migration$/);
  });

  it("gives the same address the same pseudonym every time, within a repo", () => {
    const redactor = redactEmails(REPO_ROOT);

    expect(redactor("dana@acme.example")).toBe(redactor("dana@acme.example"));
  });

  it("gives the same address a different pseudonym in a different repo", () => {
    expect(redactEmails(REPO_ROOT)("dana@acme.example")).not.toBe(
      redactEmails(OTHER_REPO_ROOT)("dana@acme.example"),
    );
  });

  it("keeps two people apart", () => {
    const redactor = redactEmails(REPO_ROOT);

    expect(redactor("dana@acme.example")).not.toBe(redactor("sam@acme.example"));
  });

  it("treats a differently-cased address as the same person", () => {
    const redactor = redactEmails(REPO_ROOT);

    expect(redactor("Dana@Acme.Example")).toBe(redactor("dana@acme.example"));
  });

  it("replaces every address in a git log, not just the first", () => {
    const output = redactEmails(REPO_ROOT)(
      "Author: Dana <dana@acme.example>\nReviewed-by: Sam <sam@acme.example>",
    );

    expect(output).not.toMatch(/@acme\.example/);
    expect(output.match(/author-[0-9a-f]{4}/g)).toHaveLength(2);
  });

  it("is idempotent — a pseudonym is not itself an address", () => {
    const redactor = redactEmails(REPO_ROOT);
    const once = redactor("dana@acme.example");

    expect(redactor(once)).toBe(once);
  });

  it("emits the documented shape: AUTHOR_PSEUDONYM_PREFIX plus four hex characters", () => {
    expect(redactEmails(REPO_ROOT)("dana@acme.example")).toMatch(pseudonymRe);
  });

  it("replaces the whole address when the domain has subdomains", () => {
    // A partial match would leave the tail of the domain in the text, which
    // is both a leak and a sentence that reads as nonsense.
    const output = redactEmails(REPO_ROOT)("mail from dana@mail.eng.acme.example today");

    expect(output).toBe(`mail from ${redactEmails(REPO_ROOT)("dana@mail.eng.acme.example")} today`);
    expect(output).not.toContain(".example");
    expect(output).not.toContain("acme");
  });

  it("is exactly AUTHOR_PSEUDONYM's formula, over the lower-cased address", () => {
    // Pinned rather than merely "some stable hash": 13-constants.md documents
    // the formula as sha256(email + repoRoot)[:4], and a pseudonym is only
    // reproducible outside this codebase if the inputs are what the doc says.
    // The lower-casing is signposts' own addition — same person, one identity.
    const expected = createHash("sha256")
      .update(`dana@acme.example${REPO_ROOT}`)
      .digest("hex")
      .slice(0, 4);

    expect(redactEmails(REPO_ROOT)("Dana@Acme.Example")).toBe(
      `${AUTHOR_PSEUDONYM_PREFIX}${expected}`,
    );
  });

  it("leaves text with no address alone", () => {
    const text = "the build fails on node 24 @ the type-stripping step";

    expect(redactEmails(REPO_ROOT)(text)).toBe(text);
  });
});

describe("wireRedactors — the set that runs before text leaves the machine", () => {
  it("covers emails, which defaultRedactors does not", () => {
    const text = "ping dana@acme.example";

    expect(redact(text, wireRedactors(REPO_ROOT))).not.toContain("dana@acme.example");
    expect(redact(text)).toContain("dana@acme.example");
  });

  it("still covers every secret pattern the default set covered", () => {
    const output = redact(
      "key AKIAIOSFODNN7EXAMPLE and postgres://u:p@host/db and dana@acme.example",
      wireRedactors(REPO_ROOT),
    );

    expect(output).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(output).not.toContain("postgres://u:p@host/db");
    expect(output).not.toContain("dana@acme.example");
  });

  it("leaves a credentialled connection string as a connection string, not as a person", () => {
    // Emails run last precisely so `user:pass@host.com` is claimed by the
    // earlier, more specific stage.
    const output = redact("postgres://dbuser:dbpass@dbhost.example/db", wireRedactors(REPO_ROOT));

    expect(output).toContain("connection-string");
    expect(output).not.toContain(AUTHOR_PSEUDONYM_PREFIX);
  });
});
