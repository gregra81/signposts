import { describe, expect, it } from "vitest";
import { ftsQuery } from "../../../src/core/retrieval/fts-query.js";

describe("ftsQuery", () => {
  it("converts claim text into a quoted-OR FTS5 query", () => {
    expect(ftsQuery("Run make build before make test.")).toBe('"Run" OR "make" OR "build" OR "before" OR "make" OR "test"');
  });

  it("returns null for text with no tokens", () => {
    expect(ftsQuery("...")).toBeNull();
  });
});
