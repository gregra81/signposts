import { describe, expect, it } from "vitest";
import { indexExitCode } from "../../../src/core/cli/index-exit-code.js";

describe("indexExitCode", () => {
  it("no failures -> 0", () => {
    expect(indexExitCode(false)).toBe(0);
  });

  it("some failure -> 1", () => {
    expect(indexExitCode(true)).toBe(1);
  });
});
