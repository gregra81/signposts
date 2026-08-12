import { describe, expect, it } from "vitest";
import { pathOverlapBoost } from "../../../src/core/retrieval/path-overlap.js";

describe("pathOverlapBoost", () => {
  it("is true when a path matches between candidate and neighbour", () => {
    expect(pathOverlapBoost(["src/io/db/migrate.ts", "src/core/retrieval/rrf.ts"], ["src/io/db/migrate.ts"])).toBe(
      true,
    );
  });

  it("is false when there is no overlap", () => {
    expect(pathOverlapBoost(["src/a.ts"], ["src/b.ts"])).toBe(false);
  });

  it("is false when the candidate has no paths", () => {
    expect(pathOverlapBoost(undefined, ["src/a.ts"])).toBe(false);
  });

  it("is false when the neighbour has no paths", () => {
    expect(pathOverlapBoost(["src/a.ts"], undefined)).toBe(false);
  });

  it("is false when both are empty arrays", () => {
    expect(pathOverlapBoost([], [])).toBe(false);
  });

  it("is true regardless of how many paths are shared, not just one", () => {
    expect(pathOverlapBoost(["src/a.ts", "src/b.ts"], ["src/a.ts", "src/b.ts", "src/c.ts"])).toBe(true);
  });
});
