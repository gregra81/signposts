import { describe, it } from "vitest";
import fc from "fast-check";

describe("fast-check smoke test", () => {
  it("string concatenation length is the sum of the two lengths", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        return (a + b).length === a.length + b.length;
      }),
    );
  });
});
