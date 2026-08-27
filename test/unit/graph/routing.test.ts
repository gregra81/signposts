import { describe, expect, it } from "vitest";
import { criticRoute, rejectRatio, validateRoute } from "../../../src/core/graph/routing.js";
import {
  CRITIC_REJECT_RATIO,
  MAX_EXTRACT_ATTEMPTS,
  MAX_VALIDATE_ATTEMPTS,
} from "../../../src/core/config/constants.js";
import type { CriticVerdict } from "../../../src/core/contracts/graph.js";

function verdicts(keeps: boolean[]): CriticVerdict[] {
  return keeps.map((keep, index) => ({ tempId: `t${index}`, keep, reason: "because" }));
}

describe("rejectRatio", () => {
  it("is 0 for an empty batch rather than NaN", () => {
    expect(rejectRatio([])).toBe(0);
  });

  it.each([
    [[true, true, true], 0],
    [[false, true, true], 1 / 3],
    [[false, false, true], 2 / 3],
    [[false, false, false], 1],
  ])("counts rejections over the batch (%j)", (keeps, expected) => {
    expect(rejectRatio(verdicts(keeps))).toBeCloseTo(expected);
  });
});

describe("criticRoute — the reflection loop", () => {
  const allRejected = verdicts([false, false, false]);
  const allKept = verdicts([true, true, true]);

  it("retries extraction when the critic rejected almost everything and the budget is open", () => {
    expect(criticRoute({ verdicts: allRejected, extractAttempts: 1 })).toBe("retry-extract");
  });

  it("continues when the critic kept enough", () => {
    expect(criticRoute({ verdicts: allKept, extractAttempts: 1 })).toBe("continue");
  });

  // The bound. Without it this is the loop that burns a budget overnight.
  it("continues once MAX_EXTRACT_ATTEMPTS is reached, however bad the batch", () => {
    expect(criticRoute({ verdicts: allRejected, extractAttempts: MAX_EXTRACT_ATTEMPTS })).toBe(
      "continue",
    );
  });

  it("continues past the bound too", () => {
    expect(criticRoute({ verdicts: allRejected, extractAttempts: MAX_EXTRACT_ATTEMPTS + 1 })).toBe(
      "continue",
    );
  });

  it("retries on the first attempt", () => {
    expect(criticRoute({ verdicts: allRejected, extractAttempts: 0 })).toBe("retry-extract");
  });

  // An empty extraction is a correct, common outcome — re-running it would
  // spend the budget to get the same empty list back.
  it("continues on an empty batch", () => {
    expect(criticRoute({ verdicts: [], extractAttempts: 0 })).toBe("continue");
  });

  // The threshold is "more than", not "at least": a batch sitting exactly on
  // CRITIC_REJECT_RATIO does not trigger a retry. 33 of 50 is exactly 0.66.
  it("does not retry at exactly CRITIC_REJECT_RATIO", () => {
    const onThreshold = verdicts(Array.from({ length: 50 }, (_v, index) => index >= 33));
    expect(rejectRatio(onThreshold)).toBe(CRITIC_REJECT_RATIO);
    expect(criticRoute({ verdicts: onThreshold, extractAttempts: 0 })).toBe("continue");
  });

  it("retries just above CRITIC_REJECT_RATIO", () => {
    const justOver = verdicts(Array.from({ length: 50 }, (_v, index) => index >= 34));
    expect(rejectRatio(justOver)).toBeGreaterThan(CRITIC_REJECT_RATIO);
    expect(criticRoute({ verdicts: justOver, extractAttempts: 0 })).toBe("retry-extract");
  });
});

describe("validateRoute — the self-correction loop", () => {
  it("continues when nothing failed schema-lint", () => {
    expect(validateRoute({ validationErrors: [], validateAttempts: 0 })).toBe("continue");
  });

  it("continues even at the attempt bound when there are no errors", () => {
    expect(validateRoute({ validationErrors: [], validateAttempts: MAX_VALIDATE_ATTEMPTS })).toBe(
      "continue",
    );
  });

  it("retries while the budget is open", () => {
    expect(validateRoute({ validationErrors: ["bad claim"], validateAttempts: 1 })).toBe(
      "retry-extract",
    );
  });

  // The whole point of bounding this loop: a bad candidate is dropped, the
  // run carries on. It never fails.
  it("drops the offending operations once MAX_VALIDATE_ATTEMPTS is spent", () => {
    expect(
      validateRoute({ validationErrors: ["bad claim"], validateAttempts: MAX_VALIDATE_ATTEMPTS }),
    ).toBe("drop-invalid");
  });

  it("keeps dropping past the bound", () => {
    expect(
      validateRoute({
        validationErrors: ["bad claim"],
        validateAttempts: MAX_VALIDATE_ATTEMPTS + 1,
      }),
    ).toBe("drop-invalid");
  });
});
