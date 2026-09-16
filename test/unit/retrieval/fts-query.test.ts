import { describe, expect, it } from "vitest";
import { ftsQuery } from "../../../src/core/retrieval/fts-query.js";

describe("ftsQuery", () => {
  it("converts claim text into a quoted-OR FTS5 query", () => {
    // "before" is dropped: it is a stopword, and every document that contains
    // it is already in the OR by way of a content word.
    expect(ftsQuery("Run make build before make test.")).toBe('"Run" OR "make" OR "build" OR "make" OR "test"');
  });

  it("drops stopwords, which match most of the corpus and rank it on nothing", () => {
    expect(ftsQuery("is it safe to apply schema changes to the staging environment")).toBe(
      '"safe" OR "apply" OR "schema" OR "changes" OR "staging" OR "environment"',
    );
  });

  it("keeps the stopwords when they are all there is, rather than dropping the lexical half entirely", () => {
    // Rare in a real claim, but the alternative is `null`, which removes one of
    // the two lists the fusion needs for text that does have words in it.
    expect(ftsQuery("It is what it is.")).toBe('"It" OR "is" OR "what" OR "it" OR "is"');
  });

  it("matches stopwords case-insensitively", () => {
    expect(ftsQuery("The Build Is Broken")).toBe('"Build" OR "Broken"');
  });

  it("returns null for text with no tokens", () => {
    expect(ftsQuery("...")).toBeNull();
  });
});
