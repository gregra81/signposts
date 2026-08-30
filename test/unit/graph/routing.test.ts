import { describe, expect, it } from "vitest";
import { criticRoute, rejectRatio, validateRoute } from "../../../src/core/graph/routing.js";
import {
  CRITIC_REJECT_RATIO,
  MAX_EXTRACT_ATTEMPTS,
  MAX_VALIDATE_ATTEMPTS,
} from "../../../src/core/config/constants.js";
import type { Candidate, CriticVerdict } from "../../../src/core/contracts/graph.js";

/** `count` candidates, tempIds t0..t(count-1). */
function candidates(count: number): Candidate[] {
  return Array.from({ length: count }, (_value, index) => ({
    tempId: `t${index}`,
    claim: `Claim ${index}`,
    category: "decision" as const,
    scope: { repo: "acme/api" },
    evidence: "Said in the session.",
    confidence: 0.9,
    hedged: false,
  }));
}

/** One verdict per entry, addressed to t0..tN in order. */
function verdicts(keeps: boolean[]): CriticVerdict[] {
  return keeps.map((keep, index) => ({ tempId: `t${index}`, keep, reason: "because" }));
}

/** A batch of `keeps.length` candidates, each with its own verdict. */
function answered(keeps: boolean[]) {
  return { candidates: candidates(keeps.length), verdicts: verdicts(keeps) };
}

describe("rejectRatio", () => {
  it("is 0 for an empty batch rather than NaN", () => {
    expect(rejectRatio([], [])).toBe(0);
  });

  it.each([
    [[true, true, true], 0],
    [[false, true, true], 1 / 3],
    [[false, false, true], 2 / 3],
    [[false, false, false], 1],
  ])("counts what was not kept, over the batch (%j)", (keeps, expected) => {
    const { candidates: batch, verdicts: given } = answered(keeps);
    expect(rejectRatio(batch, given)).toBeCloseTo(expected);
  });

  // The truncated-reply case. Counting only the answers scored this 0 and let
  // four good candidates be dropped with no retry and nothing logged.
  it("counts a candidate the critic never answered as not kept", () => {
    expect(rejectRatio(candidates(5), verdicts([true]))).toBeCloseTo(4 / 5);
  });

  it("ignores a verdict naming a candidate that is not in the batch", () => {
    const stray: CriticVerdict[] = [{ tempId: "nobody", keep: true, reason: "because" }];
    expect(rejectRatio(candidates(2), stray)).toBe(1);
  });

  it("is 0 when the critic kept everything", () => {
    expect(rejectRatio(candidates(3), verdicts([true, true, true]))).toBe(0);
  });
});

describe("criticRoute — the reflection loop", () => {
  const allRejected = answered([false, false, false]);
  const allKept = answered([true, true, true]);

  it("retries extraction when the critic kept almost nothing and the budget is open", () => {
    expect(criticRoute({ ...allRejected, criticRetries: 0 })).toBe("retry-extract");
  });

  it("continues when the critic kept enough", () => {
    expect(criticRoute({ ...allKept, criticRetries: 0 })).toBe("continue");
  });

  // The bound. Without it this is the loop that burns a budget overnight.
  it("continues once the loop has spent its retries, however bad the batch", () => {
    expect(criticRoute({ ...allRejected, criticRetries: MAX_EXTRACT_ATTEMPTS - 1 })).toBe(
      "continue",
    );
  });

  it("continues past the bound too", () => {
    expect(criticRoute({ ...allRejected, criticRetries: MAX_EXTRACT_ATTEMPTS })).toBe("continue");
  });

  // The regression the shared counter caused: a self-correction retry used to
  // push the counter past the bound, and the critic was ignored from then on.
  it("still honours its own budget after the self-correction loop re-ran extract", () => {
    expect(criticRoute({ ...allRejected, criticRetries: 0 })).toBe("retry-extract");
  });

  // An empty extraction is a correct, common outcome — re-running it would
  // spend the budget to get the same empty list back.
  it("continues on an empty batch", () => {
    expect(criticRoute({ candidates: [], verdicts: [], criticRetries: 0 })).toBe("continue");
  });

  it("retries when the critic answered about none of the candidates", () => {
    expect(criticRoute({ candidates: candidates(3), verdicts: [], criticRetries: 0 })).toBe(
      "retry-extract",
    );
  });

  // The threshold is "more than", not "at least": a batch sitting exactly on
  // CRITIC_REJECT_RATIO does not trigger a retry. 33 of 50 is exactly 0.66.
  it("does not retry at exactly CRITIC_REJECT_RATIO", () => {
    const onThreshold = answered(Array.from({ length: 50 }, (_v, index) => index >= 33));
    expect(rejectRatio(onThreshold.candidates, onThreshold.verdicts)).toBe(CRITIC_REJECT_RATIO);
    expect(criticRoute({ ...onThreshold, criticRetries: 0 })).toBe("continue");
  });

  it("retries just above CRITIC_REJECT_RATIO", () => {
    const justOver = answered(Array.from({ length: 50 }, (_v, index) => index >= 34));
    expect(rejectRatio(justOver.candidates, justOver.verdicts)).toBeGreaterThan(
      CRITIC_REJECT_RATIO,
    );
    expect(criticRoute({ ...justOver, criticRetries: 0 })).toBe("retry-extract");
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
