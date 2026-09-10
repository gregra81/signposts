// The one rule this module exists to keep: `search_signposts` answers, in
// every state it can be in. See src/core/mcp/search-tool.ts's header and
// 05-retrieval.md, "The MCP server on a cold clone".

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEARCH_LIMIT,
  diagnosticFor,
  renderOutput,
  SEARCH_TOOL_DESCRIPTION,
  SEARCH_TOOL_NAME,
  SEARCH_UNAVAILABLE,
  searchInputSchema,
  searchOutput,
  searchOutputSchema,
  unavailableOutput,
  type SearchUnavailable,
  type SignpostHit,
} from "../../../src/core/mcp/search-tool.js";
import { CLAUDE_MD_POINTER } from "../../../src/core/init/policy.js";
import { INDEX_FILENAME, SIGNPOSTS_DIRNAME } from "../../../src/core/config/constants.js";

const REASONS = Object.values(SEARCH_UNAVAILABLE) as SearchUnavailable[];

const hit: SignpostHit = {
  id: "staging-db-read-only",
  claim: "The staging database is read-only; run migrations against dev instead.",
  category: "gotcha",
  evidence: "A migration run against staging failed with a permissions error.",
  confidence: 0.9,
  score: 0.03,
};

describe("every unavailable reason", () => {
  it.each(REASONS)("%s returns an empty result rather than throwing", (reason) => {
    const output = unavailableOutput(reason);

    expect(output.results).toEqual([]);
    expect(output.diagnostic).toBe(diagnosticFor(reason));
  });

  it.each(REASONS)("%s says what still works, so an empty result is not read as an empty repo", (reason) => {
    // The fallback 15-spec.md story 62 keeps the CLAUDE.md pointer for: the
    // signposts are markdown on disk whether or not this server can search
    // them, and the diagnostic has to send the reader there.
    expect(diagnosticFor(reason)).toContain(`${SIGNPOSTS_DIRNAME}/${INDEX_FILENAME}`);
    expect(CLAUDE_MD_POINTER).toContain(`${SIGNPOSTS_DIRNAME}/${INDEX_FILENAME}`);
  });

  it("gives each reason its own wording", () => {
    const wordings = new Set(REASONS.map(diagnosticFor));

    expect(wordings.size).toBe(REASONS.length);
  });

  it("names the command that fixes an index that exists but is behind", () => {
    expect(diagnosticFor(SEARCH_UNAVAILABLE.stale_index)).toContain("signpost index");
  });

  it("does not tell a fresh clone it did something wrong", () => {
    expect(diagnosticFor(SEARCH_UNAVAILABLE.no_index)).toContain("not an error");
  });
});

describe("searchOutput", () => {
  it("carries hits through untouched, with no diagnostic", () => {
    const output = searchOutput([hit]);

    expect(output.results).toEqual([hit]);
    expect(output.diagnostic).toBeUndefined();
  });

  it("explains an empty hit list rather than returning a bare []", () => {
    expect(searchOutput([])).toEqual(unavailableOutput(SEARCH_UNAVAILABLE.no_match));
  });

  it("copies the hits, so the caller's array is not the one that goes out", () => {
    const hits = [hit];
    const output = searchOutput(hits);

    expect(output.results).not.toBe(hits);
  });
});

describe("renderOutput", () => {
  it("shows the diagnostic when there is nothing to show", () => {
    const output = unavailableOutput(SEARCH_UNAVAILABLE.no_index);

    expect(renderOutput(output)).toBe(output.diagnostic);
  });

  it("falls back to no_match for an empty result that arrived without one", () => {
    expect(renderOutput({ results: [] })).toBe(diagnosticFor(SEARCH_UNAVAILABLE.no_match));
  });

  it("renders the claim, the evidence and how the claim is classified", () => {
    const text = renderOutput(searchOutput([hit]));

    expect(text).toContain(hit.id);
    expect(text).toContain(hit.claim);
    expect(text).toContain(hit.evidence);
    expect(text).toContain(hit.category);
    expect(text).toContain(String(hit.confidence));
  });

  it("separates two hits", () => {
    const second = { ...hit, id: "prisma-schema-path", claim: "The Prisma schema lives at prisma/schema.prisma." };

    expect(renderOutput(searchOutput([hit, second])).split("\n\n")).toHaveLength(2);
  });
});

describe("the tool's declared surface", () => {
  it("is the name 12-wire-contracts.md gives it", () => {
    expect(SEARCH_TOOL_NAME).toBe("search_signposts");
  });

  it("describes the corpus rather than the retrieval mechanism", () => {
    expect(SEARCH_TOOL_DESCRIPTION).toContain(SIGNPOSTS_DIRNAME);
  });

  it("takes a query, and optionally paths and a limit", () => {
    expect(searchInputSchema.parse({ query: "how do migrations run" })).toEqual({ query: "how do migrations run" });
    expect(searchInputSchema.parse({ query: "q", paths: ["src/db"], limit: 3 })).toEqual({
      query: "q",
      paths: ["src/db"],
      limit: 3,
    });
  });

  it("rejects an empty query and a limit that cannot return anything", () => {
    expect(searchInputSchema.safeParse({ query: "" }).success).toBe(false);
    expect(searchInputSchema.safeParse({ query: "q", limit: 0 }).success).toBe(false);
    expect(searchInputSchema.safeParse({ query: "q", limit: 1.5 }).success).toBe(false);
  });

  it("defaults the limit to what the contract says", () => {
    expect(DEFAULT_SEARCH_LIMIT).toBe(5);
  });

  it("validates what it sends, both halves", () => {
    expect(searchOutputSchema.safeParse(searchOutput([hit])).success).toBe(true);
    expect(searchOutputSchema.safeParse(unavailableOutput(SEARCH_UNAVAILABLE.no_index)).success).toBe(true);
  });
});
