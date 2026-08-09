import { describe, expect, it } from "vitest";
import { generateIndexDoc } from "../../../src/core/signpost/index-doc.js";
import type { Signpost } from "../../../src/core/signpost/schema.js";

function makeSignpost(overrides: Partial<Signpost>): Signpost {
  return {
    id: "id",
    claim: "A claim.",
    category: "environment",
    scope: { repo: "acme/platform" },
    evidence: "Evidence.",
    confidence: 0.9,
    status: "active",
    provenance: {
      session_ids: ["s1"],
      authors: ["a@b.com"],
      first_seen: "2026-01-01",
      last_reinforced: "2026-01-02",
    },
    ...overrides,
  };
}

describe("generateIndexDoc", () => {
  it("renders a placeholder when there are zero active signposts", () => {
    expect(generateIndexDoc([])).toBe("# Signposts\n\nNo active signposts.\n");
  });

  it("renders a placeholder when every signpost is superseded", () => {
    const doc = generateIndexDoc([makeSignpost({ id: "old", status: "superseded" })]);
    expect(doc).toBe("# Signposts\n\nNo active signposts.\n");
  });

  it("excludes superseded signposts but includes active ones", () => {
    const doc = generateIndexDoc([
      makeSignpost({ id: "gone", status: "superseded" }),
      makeSignpost({ id: "here", status: "active" }),
    ]);
    expect(doc).toContain("here");
    expect(doc).not.toContain("gone");
  });

  it("groups by category, sections ordered per the schema's category enum, not input order", () => {
    const doc = generateIndexDoc([
      makeSignpost({ id: "e1", category: "environment" }),
      makeSignpost({ id: "c1", category: "correction" }),
      makeSignpost({ id: "p1", category: "preference" }),
    ]);
    const correctionIdx = doc.indexOf("## correction");
    const preferenceIdx = doc.indexOf("## preference");
    const environmentIdx = doc.indexOf("## environment");
    expect(correctionIdx).toBeGreaterThanOrEqual(0);
    expect(correctionIdx).toBeLessThan(preferenceIdx);
    expect(preferenceIdx).toBeLessThan(environmentIdx);
  });

  it("omits section headers for categories with no active signposts", () => {
    const doc = generateIndexDoc([makeSignpost({ id: "e1", category: "environment" })]);
    expect(doc).not.toContain("## correction");
    expect(doc).not.toContain("## gotcha");
  });

  it("preserves input order of signposts within a category", () => {
    const doc = generateIndexDoc([
      makeSignpost({ id: "first", category: "gotcha", claim: "First." }),
      makeSignpost({ id: "second", category: "gotcha", claim: "Second." }),
    ]);
    expect(doc.indexOf("first")).toBeLessThan(doc.indexOf("second"));
  });

  it("includes id, claim, and scope.repo per row", () => {
    const doc = generateIndexDoc([
      makeSignpost({ id: "my-id", claim: "My claim.", scope: { repo: "acme/thing" } }),
    ]);
    expect(doc).toContain("`my-id`");
    expect(doc).toContain("My claim.");
    expect(doc).toContain("acme/thing");
  });

  it("renders the exact table structure for two categories, one with two rows", () => {
    const doc = generateIndexDoc([
      makeSignpost({ id: "c1", category: "correction", claim: "First correction.", scope: { repo: "acme/one" } }),
      makeSignpost({ id: "c2", category: "correction", claim: "Second correction.", scope: { repo: "acme/two" } }),
      makeSignpost({ id: "p1", category: "preference", claim: "A preference.", scope: { repo: "acme/three" } }),
    ]);
    expect(doc).toBe(
      [
        "# Signposts",
        "",
        "## correction",
        "",
        "| id | claim | repo |",
        "| --- | --- | --- |",
        "| `c1` | First correction. | acme/one |",
        "| `c2` | Second correction. | acme/two |",
        "",
        "## preference",
        "",
        "| id | claim | repo |",
        "| --- | --- | --- |",
        "| `p1` | A preference. | acme/three |",
        "",
      ].join("\n"),
    );
  });

  it("escapes pipe characters in claim text so they don't break the table row", () => {
    const doc = generateIndexDoc([makeSignpost({ id: "id", claim: "Use `a | b` not `a && b`." })]);
    expect(doc).toContain("Use `a \\| b` not `a && b`.");
  });
});
