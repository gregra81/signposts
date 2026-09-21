// Node 3 writes a critique exactly when the reflection loop should run again.
// The critique names the rejected claims, and lists the kept ones separately
// so the retry returns them rather than losing them.

import { describe, expect, it } from "vitest";
import { CRITIQUE_KEPT_PREAMBLE } from "../../../../src/core/prompts/user-turns.js";
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

function criticNodeWith(verdicts: unknown[], conventions?: string) {
  const ports = makeHarness({
    script: { critic: [{ verdicts }] },
    session: gutteredSession(),
    ...(conventions === undefined ? {} : { conventions }),
  });
  return { node: makeCriticNode(ports), ports };
}

function criticNode(verdicts: unknown[]) {
  return criticNodeWith(verdicts).node;
}

// 19-value-to-a-user.md's critic-precision follow-up: a claim the repo already
// writes down is not new, and the critic could not see the repo at all.
describe("what the repo already writes down", () => {
  const verdicts = [{ tempId: "t1", keep: true, reason: "Durable." }];

  it("goes to the critic with the candidates", async () => {
    const { node, ports } = criticNodeWith(verdicts, "Business logic lives in core/.");

    await node(graphState({ candidates: [KEPT], extractAttempts: 1 }));

    expect(ports.model.callsTo("critic")[0]?.user).toContain("Business logic lives in core/.");
  });

  it("is absent for a repo with no conventions file", async () => {
    const { node, ports } = criticNodeWith(verdicts);

    await node(graphState({ candidates: [KEPT], extractAttempts: 1 }));

    expect(ports.model.callsTo("critic")[0]?.user).not.toContain("Already written down");
  });
});

describe("when the critic rejected enough to retry", () => {
  // Two of three rejected is 0.66, which is not *over* CRITIC_REJECT_RATIO —
  // three of three is.
  const verdicts = [
    { tempId: "t1", keep: false, reason: "Too vague." },
    { tempId: "t2", keep: false, reason: "Not a decision." },
    { tempId: "t3", keep: false, reason: "Restates the code." },
  ];

  it("writes a critique naming every rejected claim", async () => {
    const update = await criticNode(verdicts)(
      graphState({ candidates: [KEPT, REJECTED_A, REJECTED_B], extractAttempts: 1 }),
    );

    expect(update.critique).toContain("Too vague.");
    expect(update.critique).toContain("Not a decision.");
    expect(update.critique).toContain("Restates the code.");
  });

  it("leaves the candidates untouched — the retry replaces them wholesale", async () => {
    const update = await criticNode(verdicts)(
      graphState({ candidates: [KEPT, REJECTED_A, REJECTED_B], extractAttempts: 1 }),
    );

    expect(update.candidates).toBeUndefined();
  });

  // Scenario 007 lost its one kept claim this way: the retry prompt named only
  // the rejections and said "be stricter", and the model returned nothing
  // (19-value-to-a-user.md, "Follow-up: scenario 007"). Changed with agreement; the old
  // version asserted the kept claim was absent.
  it("lists the kept claim apart from the rejections, without its reason", async () => {
    const mixed = [
      { tempId: "t1", keep: true, reason: "Sound." },
      { tempId: "t2", keep: false, reason: "Not a decision." },
      { tempId: "t3", keep: false, reason: "Restates the code." },
    ];
    // Two of three rejected does not clear the ratio, so force the retry with
    // a batch where the kept verdict is the minority.
    const update = await criticNode([
      ...mixed,
      { tempId: "t4", keep: false, reason: "Speculative." },
    ])(
      graphState({
        candidates: [KEPT, REJECTED_A, REJECTED_B, candidate({ tempId: "t4", claim: "Maybe" })],
        extractAttempts: 1,
      }),
    );

    const [rejected, kept] = String(update.critique).split(CRITIQUE_KEPT_PREAMBLE);
    expect(rejected).not.toContain(KEPT.claim);
    expect(rejected).toContain("Speculative.");
    expect(kept).toContain(KEPT.claim);
    expect(kept).not.toContain(REJECTED_A.claim);
    expect(update.critique).not.toContain("Sound.");
  });
});

// `rejectRatio` counts an unanswered candidate as rejected — "silence about
// one is a missing answer". The critique has to agree, or a truncated reply
// routes back to `extract` carrying a retry prompt that names nothing and the
// model returns the same batch.
describe("when the critic answered only some of the batch", () => {
  const CANDIDATES = [KEPT, REJECTED_A, REJECTED_B, candidate({ tempId: "t4", claim: "Maybe" })];

  it("names the unanswered candidates in the critique", async () => {
    const update = await criticNode([{ tempId: "t1", keep: true, reason: "Sound." }])(
      graphState({ candidates: CANDIDATES, extractAttempts: 1 }),
    );

    expect(update.critique).toContain(REJECTED_A.claim);
    expect(update.critique).toContain(REJECTED_B.claim);
    expect(update.critique).toContain("no verdict returned");
    // Changed with agreement, as above: the kept claim is carried, not dropped.
    expect(String(update.critique).split(CRITIQUE_KEPT_PREAMBLE)[1]).toContain(KEPT.claim);
  });
});

describe("when the batch was good enough to continue", () => {
  it("clears the critique and keeps the survivors", async () => {
    const update = await criticNode([
      { tempId: "t1", keep: true, reason: "Sound." },
      { tempId: "t2", keep: false, reason: "Not a decision." },
    ])(graphState({ candidates: [KEPT, REJECTED_A], extractAttempts: 1 }));

    expect(update.critique).toBeUndefined();
    expect(update.candidates).toEqual([KEPT]);
  });
});
