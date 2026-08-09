import { describe, expect, it } from "vitest";
import { parseSignpost, serialiseSignpost } from "../../../src/core/signpost/codec.js";
import type { Signpost } from "../../../src/core/signpost/schema.js";

const VALID: Signpost = {
  id: "staging-db-read-only",
  claim: "The staging database is read-only; run migrations against dev instead.",
  category: "environment",
  scope: { repo: "acme/platform", paths: ["prisma/**", "scripts/migrate*"] },
  evidence:
    "A migration run against staging failed with a permissions error that read as a\nconnection problem. Staging is a read-only replica; the writable instance is dev.",
  confidence: 0.91,
  status: "active",
  provenance: {
    session_ids: ["01J8X", "01J9F"],
    authors: ["rashkevitch@gmail.com"],
    first_seen: "2026-07-14",
    last_reinforced: "2026-07-28",
  },
};

describe("serialiseSignpost", () => {
  it("matches the on-disk format from 03-memory-model.md (frontmatter, blank line, body)", () => {
    const text = serialiseSignpost(VALID);
    expect(text).toBe(
      [
        "---",
        "id: staging-db-read-only",
        "claim: The staging database is read-only; run migrations against dev instead.",
        "category: environment",
        "scope:",
        "  repo: acme/platform",
        "  paths:",
        "    - prisma/**",
        "    - scripts/migrate*",
        "confidence: 0.91",
        "status: active",
        "provenance:",
        "  session_ids:",
        "    - 01J8X",
        "    - 01J9F",
        "  authors:",
        "    - rashkevitch@gmail.com",
        "  first_seen: 2026-07-14",
        "  last_reinforced: 2026-07-28",
        "---",
        "",
        "A migration run against staging failed with a permissions error that read as a",
        "connection problem. Staging is a read-only replica; the writable instance is dev.",
        "",
      ].join("\n"),
    );
  });

  it("includes supersedes only when present", () => {
    expect(serialiseSignpost(VALID)).not.toContain("supersedes");
    expect(serialiseSignpost({ ...VALID, supersedes: ["old-id"] })).toContain("supersedes:\n  - old-id");
  });

  it("does not duplicate evidence in the frontmatter", () => {
    const text = serialiseSignpost(VALID);
    const frontmatter = text.slice(0, text.indexOf("\n---\n", 4));
    expect(frontmatter).not.toContain("evidence");
  });
});

describe("parseSignpost", () => {
  it("round-trips a serialised signpost", () => {
    expect(parseSignpost(serialiseSignpost(VALID))).toEqual(VALID);
  });

  it("throws on text with no frontmatter delimiters", () => {
    expect(() => parseSignpost("just some text, no frontmatter")).toThrow(/frontmatter/);
  });

  it("throws on frontmatter that isn't a YAML mapping (array)", () => {
    expect(() => parseSignpost("---\n- a\n- b\n---\n\nbody")).toThrow(/mapping/);
  });

  it("throws on frontmatter that isn't a YAML mapping (scalar)", () => {
    expect(() => parseSignpost("---\nplain string\n---\n\nbody")).toThrow(/mapping/);
  });

  it("throws on frontmatter that isn't a YAML mapping (empty, parses to null)", () => {
    expect(() => parseSignpost("---\n\n---\n\nbody")).toThrow(/mapping/);
  });

  it("throws on frontmatter failing schema validation (bad claim)", () => {
    const text = serialiseSignpost({ ...VALID, claim: "line one\nline two" });
    expect(() => parseSignpost(text)).toThrow();
  });
});
