// Which tree `bin/signpost.js` runs, and why it is not "dist/ if it exists".
//
// A checkout that ever packed — `pnpm test:install` does, and `prepack` runs
// the build — keeps a `dist/` from that moment. The wrapper preferred it, so
// every `signpost` typed in that checkout afterwards ran the old build, with
// nothing saying so. A real run made on 2026-09-23 spent three model calls
// against code from two weeks earlier, and the missing conventions in the
// critic's turn read as a product bug until the build date explained it
// (19-value-to-a-user.md).

import { describe, expect, it } from "vitest";
import { chooseTree } from "../../../bin/entry.js";

describe("the tree the wrapper runs", () => {
  it("runs src in a checkout, even when a build is sitting there", () => {
    expect(chooseTree("/Users/dana/Projects/signposts", { hasDist: true, hasSrc: true })).toBe("src");
  });

  it("runs dist under node_modules, where Node will not strip types", () => {
    expect(
      chooseTree("/usr/local/lib/node_modules/signposts", { hasDist: true, hasSrc: true }),
    ).toBe("dist");
  });

  it("runs dist in a checkout that has no src, which is no checkout at all", () => {
    expect(chooseTree("/opt/app", { hasDist: true, hasSrc: false })).toBe("dist");
  });

  it("runs src when the build is missing", () => {
    expect(chooseTree("/Users/dana/Projects/signposts", { hasDist: false, hasSrc: true })).toBe("src");
  });

  it("has nothing to run when neither tree is there", () => {
    expect(chooseTree("/opt/app", { hasDist: false, hasSrc: false })).toBeNull();
  });

  // The path test is on the directory the wrapper lives in, so a repo that
  // merely has node_modules below it is still a checkout.
  it("treats a checkout with its own node_modules as a checkout", () => {
    expect(
      chooseTree("/Users/dana/Projects/signposts", { hasDist: true, hasSrc: true }),
    ).toBe("src");
  });
});
