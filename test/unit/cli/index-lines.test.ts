import { describe, expect, it } from "vitest";
import { indexFinishedLine, indexStartedLine } from "../../../src/core/cli/index-lines.js";
import type { ModelCacheStatus } from "../../../src/core/doctor/report.js";

describe("indexStartedLine", () => {
  it("warns about the download only when the cache is cold", () => {
    expect(indexStartedLine("cold")).toContain("downloading the embedding model");
    expect(indexStartedLine("cold")).toContain("~23MB");
  });

  // The three states where no download is about to happen: cached, read from
  // a local path, or refused outright. Promising one is the misdiagnosis
  // src/core/doctor/report.ts exists to avoid.
  it.each<ModelCacheStatus>(["warm", "vendored", "unavailable"])("says only what it is doing when %s", (cache) => {
    expect(indexStartedLine(cache)).toBe("rebuilding the index");
  });

  it("names the work in every state, so the line is never bare", () => {
    for (const cache of ["cold", "warm", "vendored", "unavailable"] as const) {
      expect(indexStartedLine(cache)).toContain("rebuilding the index");
    }
  });
});

describe("indexFinishedLine", () => {
  it("reports what it indexed", () => {
    expect(indexFinishedLine(3, true)).toBe("indexed 3 signposts");
  });

  it("does not claim to have indexed when nothing was rebuilt", () => {
    expect(indexFinishedLine(3, false)).toBe("index already up to date (3 signposts)");
  });

  it("counts one signpost in the singular", () => {
    expect(indexFinishedLine(1, true)).toBe("indexed 1 signpost");
    expect(indexFinishedLine(1, false)).toBe("index already up to date (1 signpost)");
  });

  it("says so for an empty corpus rather than saying nothing", () => {
    expect(indexFinishedLine(0, true)).toBe("indexed 0 signposts");
  });
});
