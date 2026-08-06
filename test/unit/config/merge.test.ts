import { describe, expect, it } from "vitest";
import { mergeLeaves } from "../../../src/core/config/merge.js";

describe("mergeLeaves", () => {
  it("overwrites only the leaves present in the override, per-leaf not per-file", () => {
    const base = {
      retrieval: { k: 6, embedding_model: "base-model", allow_remote_models: true },
      git: { branch_pattern: "signposts/{author_slug}", auto_merge: false },
    };
    const override = { retrieval: { k: 8 } };

    const merged = mergeLeaves(base, override);

    expect(merged).toEqual({
      retrieval: { k: 8, embedding_model: "base-model", allow_remote_models: true },
      git: { branch_pattern: "signposts/{author_slug}", auto_merge: false },
    });
  });

  it("recurses through multiple nested levels", () => {
    const base = { a: { b: { c: 1, d: 2 } } };
    const override = { a: { b: { c: 99 } } };

    expect(mergeLeaves(base, override)).toEqual({ a: { b: { c: 99, d: 2 } } });
  });

  it("overwrites a leaf value with null rather than merging into it", () => {
    const base = { retrieval: { local_model_path: "/some/path" } };
    const override = { retrieval: { local_model_path: null } };

    expect(mergeLeaves(base, override)).toEqual({ retrieval: { local_model_path: null } });
  });

  it("overwrites, rather than concatenates, array leaves", () => {
    const base = { tags: ["a", "b"] };
    const override = { tags: ["c"] };

    expect(mergeLeaves(base, override)).toEqual({ tags: ["c"] });
  });

  it("adds keys present only in the override", () => {
    const base = {};
    const override = { retrieval: { k: 10 } };

    expect(mergeLeaves(base, override)).toEqual({ retrieval: { k: 10 } });
  });

  it("does not mutate either input", () => {
    const base = { retrieval: { k: 6 } };
    const override = { retrieval: { k: 8 } };

    mergeLeaves(base, override);

    expect(base).toEqual({ retrieval: { k: 6 } });
    expect(override).toEqual({ retrieval: { k: 8 } });
  });

  it("overwrites, rather than recurses into, a null base leaf", () => {
    const base = { retrieval: null };
    const overrideValue = { k: 6 };

    expect(() => mergeLeaves(base, { retrieval: overrideValue })).not.toThrow();
    expect(mergeLeaves(base, { retrieval: overrideValue }).retrieval).toBe(overrideValue);
  });

  it("overwrites, rather than recurses into, a non-plain-object base leaf (e.g. a Date)", () => {
    const base = { seenAt: new Date(0) };
    const overrideValue = { iso: "2026-01-01" };

    const merged = mergeLeaves(base, { seenAt: overrideValue });

    // Reference equality, not just deep equality: a wrongly-"plain"
    // classification would rebuild the override into a new object via
    // recursion instead of taking it wholesale.
    expect(merged.seenAt).toBe(overrideValue);
  });
});
