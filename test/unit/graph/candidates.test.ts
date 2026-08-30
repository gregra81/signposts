import { describe, expect, it } from "vitest";
import { acceptCandidates, applyHedgeCap, survivors } from "../../../src/core/graph/candidates.js";
import {
  AUTO_PUBLISH_CONFIDENCE,
  HEDGE_CONFIDENCE_CAP,
  MAX_CANDIDATES_PER_SESSION,
} from "../../../src/core/config/constants.js";
import type { Candidate, CriticVerdict } from "../../../src/core/contracts/graph.js";

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    tempId: "t1",
    claim: "Staging is read-only outside the ETL window",
    category: "environment",
    scope: { repo: "acme/api" },
    evidence: "The human said so after a failed write.",
    confidence: 0.9,
    hedged: false,
    ...overrides,
  };
}

describe("applyHedgeCap", () => {
  it("caps a hedged candidate at HEDGE_CONFIDENCE_CAP", () => {
    expect(applyHedgeCap(candidate({ hedged: true, confidence: 0.95 })).confidence).toBe(
      HEDGE_CONFIDENCE_CAP,
    );
  });

  it("leaves an unhedged candidate alone", () => {
    expect(applyHedgeCap(candidate({ hedged: false, confidence: 0.95 })).confidence).toBe(0.95);
  });

  it("does not raise a hedged candidate already below the cap", () => {
    const low = HEDGE_CONFIDENCE_CAP - 0.1;
    expect(applyHedgeCap(candidate({ hedged: true, confidence: low })).confidence).toBe(low);
  });

  // Asserted by identity, not by value: a candidate already at the cap must
  // be returned untouched. Comparing confidence alone cannot tell "left alone"
  // from "copied and re-capped to the same number".
  it("returns a hedged candidate sitting exactly on the cap untouched", () => {
    const input = candidate({ hedged: true, confidence: HEDGE_CONFIDENCE_CAP });
    expect(applyHedgeCap(input)).toBe(input);
  });

  // The cap is what stops someone else's stated uncertainty auto-publishing.
  it("puts every hedged candidate below the auto-publish threshold", () => {
    expect(applyHedgeCap(candidate({ hedged: true, confidence: 1 })).confidence).toBeLessThan(
      AUTO_PUBLISH_CONFIDENCE,
    );
  });

  it("preserves the other fields", () => {
    const input = candidate({ hedged: true, confidence: 1 });
    expect(applyHedgeCap(input)).toEqual({ ...input, confidence: HEDGE_CONFIDENCE_CAP });
  });
});

describe("acceptCandidates", () => {
  it("applies the hedge cap to every candidate", () => {
    const accepted = acceptCandidates([
      candidate({ tempId: "a", hedged: true, confidence: 1 }),
      candidate({ tempId: "b", hedged: false, confidence: 1 }),
    ]);
    expect(accepted.map((c) => c.confidence)).toEqual([HEDGE_CONFIDENCE_CAP, 1]);
  });

  it("truncates to MAX_CANDIDATES_PER_SESSION", () => {
    const many = Array.from({ length: MAX_CANDIDATES_PER_SESSION + 5 }, (_v, index) =>
      candidate({ tempId: `t${index}` }),
    );
    expect(acceptCandidates(many)).toHaveLength(MAX_CANDIDATES_PER_SESSION);
  });

  it("keeps the first candidates when truncating", () => {
    const many = Array.from({ length: MAX_CANDIDATES_PER_SESSION + 1 }, (_v, index) =>
      candidate({ tempId: `t${index}` }),
    );
    expect(acceptCandidates(many).at(-1)?.tempId).toBe(`t${MAX_CANDIDATES_PER_SESSION - 1}`);
  });

  it("passes a batch at exactly the limit through untruncated", () => {
    const exact = Array.from({ length: MAX_CANDIDATES_PER_SESSION }, (_v, index) =>
      candidate({ tempId: `t${index}` }),
    );
    expect(acceptCandidates(exact)).toHaveLength(MAX_CANDIDATES_PER_SESSION);
  });

  it("returns an empty list for an empty extraction", () => {
    expect(acceptCandidates([])).toEqual([]);
  });
});

describe("survivors", () => {
  const kept: CriticVerdict = { tempId: "a", keep: true, reason: "specific and durable" };
  const rejected: CriticVerdict = { tempId: "b", keep: false, reason: "inferable from the code" };

  it("keeps only the candidates the critic kept", () => {
    const result = survivors(
      [candidate({ tempId: "a" }), candidate({ tempId: "b" })],
      [kept, rejected],
    );
    expect(result.map((c) => c.tempId)).toEqual(["a"]);
  });

  it("drops a candidate the critic said nothing about", () => {
    expect(survivors([candidate({ tempId: "z" })], [kept])).toEqual([]);
  });

  it("lowers confidence when the critic adjusted it down", () => {
    const result = survivors(
      [candidate({ tempId: "a", confidence: 0.9 })],
      [{ ...kept, adjustedConfidence: 0.4 }],
    );
    expect(result[0]?.confidence).toBe(0.4);
  });

  // "May only lower" — a critic that raises confidence would be promoting its
  // own judgment over the extractor's evidence, and confidence is the gate's key.
  it("ignores an adjustment that would raise confidence", () => {
    const result = survivors(
      [candidate({ tempId: "a", confidence: 0.5 })],
      [{ ...kept, adjustedConfidence: 0.99 }],
    );
    expect(result[0]?.confidence).toBe(0.5);
  });

  // Identity again: an adjustment equal to the current confidence is not an
  // adjustment, and the candidate must come through as the same object.
  it("returns the candidate untouched when the adjustment equals its confidence", () => {
    const input = candidate({ tempId: "a", confidence: 0.5 });
    const result = survivors([input], [{ ...kept, adjustedConfidence: 0.5 }]);
    expect(result[0]).toBe(input);
  });

  it("leaves confidence alone when no adjustment was given", () => {
    const result = survivors([candidate({ tempId: "a", confidence: 0.77 })], [kept]);
    expect(result[0]?.confidence).toBe(0.77);
  });

  it("preserves candidate order", () => {
    const result = survivors(
      [candidate({ tempId: "a" }), candidate({ tempId: "b" }), candidate({ tempId: "c" })],
      [
        { tempId: "c", keep: true, reason: "r" },
        { tempId: "a", keep: true, reason: "r" },
        { tempId: "b", keep: true, reason: "r" },
      ],
    );
    expect(result.map((c) => c.tempId)).toEqual(["a", "b", "c"]);
  });

  it("returns nothing when everything was rejected", () => {
    expect(survivors([candidate({ tempId: "b" })], [rejected])).toEqual([]);
  });
});
