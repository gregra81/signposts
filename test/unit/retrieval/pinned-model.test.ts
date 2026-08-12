import { describe, expect, it } from "vitest";
import { splitPinnedModel } from "../../../src/core/retrieval/pinned-model.js";

describe("splitPinnedModel", () => {
  it("splits a normal pin on its last @", () => {
    expect(splitPinnedModel("Xenova/all-MiniLM-L6-v2@abc123")).toEqual({
      repoId: "Xenova/all-MiniLM-L6-v2",
      revision: "abc123",
    });
  });

  it("splits on the last @ when the revision itself contains an @", () => {
    expect(splitPinnedModel("Xenova/all-MiniLM-L6-v2@user@abc123")).toEqual({
      repoId: "Xenova/all-MiniLM-L6-v2@user",
      revision: "abc123",
    });
  });

  it("throws when there is no @ at all", () => {
    expect(() => splitPinnedModel("Xenova/all-MiniLM-L6-v2")).toThrow(
      /is not a pinned "<repo-id>@<revision>" string/,
    );
  });

  it("throws when @ is the first character (empty repoId)", () => {
    expect(() => splitPinnedModel("@abc123")).toThrow(/is not a pinned "<repo-id>@<revision>" string/);
  });
});
