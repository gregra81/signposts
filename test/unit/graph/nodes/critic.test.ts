// Node 3 writes a critique exactly when the reflection loop should run again,
// and that critique names the rejected claims only.

import { describe, expect, it } from "vitest";
import { makeCriticNode } from "../../../../src/graph/nodes/critic.js";
import {
  candidate,
  gutteredSession,
  makeHarness,
  graphState,
} from "../../../behaviour/helpers/graph-harness.js";

const KEPT = candidate({ tempId: "t1", claim: "Staging is read only outside the ETL window" });
const REJECTED_A = candidate({ tempId: "t2", claim: "The API is fast" });
const REJECTED_B = candidate({ tempId: "t3", claim: "Tests are good" });

function criticNodeWith(verdicts: unknown[]) {
  const ports = makeHarness({
    script: { critic: [{ verdicts }] },
    session: gutteredSession(),
  });
  return makeCriticNode(ports);
}

describe("when the critic rejected enough to retry", () => {
  // Two of three rejected is 0.66, which is not *over* CRITIC_REJECT_RATIO —
  // three of three is.
  const verdicts = [
    { tempId: "t1", keep: false, reason: "Too vague." },
    { tempId: "t2", keep: false, reason: "Not a decision." },
    { tempId: "t3", keep: false, reason: "Restates the code." },
  ];

  it("writes a critique naming every rejected claim", async () => {
    const update = await criticNodeWith(verdicts)(
      graphState({ candidates: [KEPT, REJECTED_A, REJECTED_B], extractAttempts: 1 }),
    );

    expect(update.critique).toContain("Too vague.");
    expect(update.critique).toContain("Not a decision.");
    expect(update.critique).toContain("Restates the code.");
  });

  it("leaves the candidates untouched — the retry replaces them wholesale", async () => {
    const update = await criticNodeWith(verdicts)(
      graphState({ candidates: [KEPT, REJECTED_A, REJECTED_B], extractAttempts: 1 }),
    );

    expect(update.candidates).toBeUndefined();
  });

  it("names only the rejected claims, never the kept one", async () => {
    const mixed = [
      { tempId: "t1", keep: true, reason: "Sound." },
      { tempId: "t2", keep: false, reason: "Not a decision." },
      { tempId: "t3", keep: false, reason: "Restates the code." },
    ];
    // Two of three rejected does not clear the ratio, so force the retry with
    // a batch where the kept verdict is the minority.
    const update = await criticNodeWith([
      ...mixed,
      { tempId: "t4", keep: false, reason: "Speculative." },
    ])(
      graphState({
        candidates: [KEPT, REJECTED_A, REJECTED_B, candidate({ tempId: "t4", claim: "Maybe" })],
        extractAttempts: 1,
      }),
    );

    expect(update.critique).not.toContain("Sound.");
    expect(update.critique).not.toContain(KEPT.claim);
    expect(update.critique).toContain("Speculative.");
  });
});

// `rejectRatio` counts an unanswered candidate as rejected — "silence about
// one is a missing answer". The critique has to agree, or a truncated reply
// routes back to `extract` carrying a retry prompt that names nothing and the
// model returns the same batch.
describe("when the critic answered only some of the batch", () => {
  const CANDIDATES = [KEPT, REJECTED_A, REJECTED_B, candidate({ tempId: "t4", claim: "Maybe" })];

  it("names the unanswered candidates in the critique", async () => {
    const update = await criticNodeWith([{ tempId: "t1", keep: true, reason: "Sound." }])(
      graphState({ candidates: CANDIDATES, extractAttempts: 1 }),
    );

    expect(update.critique).toContain(REJECTED_A.claim);
    expect(update.critique).toContain(REJECTED_B.claim);
    expect(update.critique).toContain("no verdict returned");
    expect(update.critique).not.toContain(KEPT.claim);
  });
});

describe("when the batch was good enough to continue", () => {
  it("clears the critique and keeps the survivors", async () => {
    const update = await criticNodeWith([
      { tempId: "t1", keep: true, reason: "Sound." },
      { tempId: "t2", keep: false, reason: "Not a decision." },
    ])(graphState({ candidates: [KEPT, REJECTED_A], extractAttempts: 1 }));

    expect(update.critique).toBeUndefined();
    expect(update.candidates).toEqual([KEPT]);
  });
});
