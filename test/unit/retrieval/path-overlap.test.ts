import { describe, expect, it } from "vitest";
import { pathOverlapBoost } from "../../../src/core/retrieval/path-overlap.js";

describe("pathOverlapBoost", () => {
  it("counts exact path matches between candidate and neighbour", () => {
    expect(pathOverlapBoost(["src/io/db/migrate.ts", "src/core/retrieval/rrf.ts"], ["src/io/db/migrate.ts"])).toBe(1);
  });

  it("is 0 when there is no overlap", () => {
    expect(pathOverlapBoost(["src/a.ts"], ["src/b.ts"])).toBe(0);
  });

  it("is 0 when the candidate has no paths", () => {
    expect(pathOverlapBoost(undefined, ["src/a.ts"])).toBe(0);
  });

  it("is 0 when the neighbour has no paths", () => {
    expect(pathOverlapBoost(["src/a.ts"], undefined)).toBe(0);
  });

  it("is 0 when both are empty arrays", () => {
    expect(pathOverlapBoost([], [])).toBe(0);
  });

  it("counts every shared path, not just the first", () => {
    expect(pathOverlapBoost(["src/a.ts", "src/b.ts"], ["src/a.ts", "src/b.ts", "src/c.ts"])).toBe(2);
  });
});
