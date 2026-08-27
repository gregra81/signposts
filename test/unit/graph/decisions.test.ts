import { describe, expect, it } from "vitest";
import {
  applyDecisions,
  isReviewComplete,
  operationKey,
  OPERATION_KEY_SEPARATOR,
} from "../../../src/core/graph/decisions.js";
import type {
  GatedOperations,
  HumanDecision,
  Operation,
} from "../../../src/core/contracts/graph.js";
import type { Signpost } from "../../../src/core/signpost/schema.js";

function signpost(id: string): Signpost {
  return {
    id,
    claim: "A durable claim",
    category: "preference",
    scope: { repo: "acme/api" },
    evidence: "Stated by the human.",
    confidence: 0.9,
    provenance: {
      session_ids: ["s1"],
      authors: ["dev@acme.example"],
      first_seen: "2026-08-27",
      last_reinforced: "2026-08-27",
    },
    status: "active",
  };
}

const ADD: Operation = { op: "add", signpost: signpost("new-claim") };
const RETIRE: Operation = { op: "retire", id: "old-claim", reason: "obsolete" };
const DECIDED_AT = "2026-08-30T09:00:00.000Z";

function accept(): HumanDecision {
  return { decision: "accept", decidedAt: DECIDED_AT };
}

describe("operationKey", () => {
  it("keys an add on the id it would create", () => {
    expect(operationKey(ADD)).toBe(`add${OPERATION_KEY_SEPARATOR}new-claim`);
  });

  it.each([
    ["retire", RETIRE, "retire:old-claim"],
    ["refine", { op: "refine", id: "old-claim" } as Operation, "refine:old-claim"],
    [
      "reinforce",
      { op: "reinforce", id: "old-claim", sessionId: "s1", author: "a@b.c" } as Operation,
      "reinforce:old-claim",
    ],
    [
      "supersede",
      { op: "supersede", id: "old-claim", replacement: signpost("new-claim") } as Operation,
      "supersede:old-claim",
    ],
  ])("keys a %s on the id it targets", (_name, operation, expected) => {
    expect(operationKey(operation)).toBe(expected);
  });

  // The key has to survive a checkpoint and a process restart, so it must be
  // derivable from the operation alone.
  it("is stable across separate constructions of the same operation", () => {
    expect(operationKey({ op: "add", signpost: signpost("new-claim") })).toBe(operationKey(ADD));
  });

  it("distinguishes two operations of different kinds on the same id", () => {
    expect(operationKey({ op: "retire", id: "x", reason: "r" })).not.toBe(
      operationKey({ op: "refine", id: "x" }),
    );
  });
});

describe("applyDecisions", () => {
  const gated: GatedOperations = {
    auto: [{ op: "reinforce", id: "known", sessionId: "s1", author: "a@b.c" }],
    needsHuman: [
      { operation: ADD, reason: "low_confidence" },
      { operation: RETIRE, reason: "deletes_existing" },
    ],
  };

  it("always applies the auto set", () => {
    expect(applyDecisions({ auto: gated.auto, needsHuman: [] }, {})).toEqual(gated.auto);
  });

  it("applies an accepted operation as proposed", () => {
    const applied = applyDecisions(gated, { [operationKey(ADD)]: accept() });
    expect(applied).toEqual([...gated.auto, ADD]);
  });

  it("leaves out a rejected operation", () => {
    const applied = applyDecisions(gated, {
      [operationKey(ADD)]: { decision: "reject", decidedAt: DECIDED_AT },
    });
    expect(applied).toEqual(gated.auto);
  });

  it("applies the replacement when the human edited it", () => {
    const edited: Operation = { op: "add", signpost: signpost("edited-claim") };
    const applied = applyDecisions(gated, {
      [operationKey(ADD)]: { decision: "edit", edited, decidedAt: DECIDED_AT },
    });
    expect(applied).toEqual([...gated.auto, edited]);
  });

  // Silence is not consent. Nothing merges automatically.
  it("leaves out an operation nobody answered", () => {
    expect(applyDecisions(gated, {})).toEqual(gated.auto);
  });

  it("applies each answered operation independently", () => {
    const applied = applyDecisions(gated, {
      [operationKey(ADD)]: accept(),
      [operationKey(RETIRE)]: { decision: "reject", decidedAt: DECIDED_AT },
    });
    expect(applied).toEqual([...gated.auto, ADD]);
  });

  it("keeps gate order: auto first, then the accepted gated ones in order", () => {
    const applied = applyDecisions(gated, {
      [operationKey(ADD)]: accept(),
      [operationKey(RETIRE)]: accept(),
    });
    expect(applied).toEqual([...gated.auto, ADD, RETIRE]);
  });

  it("falls back to the proposed operation when an edit carries no replacement", () => {
    const applied = applyDecisions(gated, {
      [operationKey(ADD)]: { decision: "edit", decidedAt: DECIDED_AT },
    });
    expect(applied).toEqual([...gated.auto, ADD]);
  });
});

describe("isReviewComplete", () => {
  const gated: GatedOperations = {
    auto: [],
    needsHuman: [
      { operation: ADD, reason: "low_confidence" },
      { operation: RETIRE, reason: "deletes_existing" },
    ],
  };

  it("is true when nothing needs a human", () => {
    expect(isReviewComplete({ auto: [], needsHuman: [] }, {})).toBe(true);
  });

  it("is false when no decision has arrived", () => {
    expect(isReviewComplete(gated, {})).toBe(false);
  });

  it("is false when only some operations were answered", () => {
    expect(isReviewComplete(gated, { [operationKey(ADD)]: accept() })).toBe(false);
  });

  it("is true once every gated operation has a decision", () => {
    expect(
      isReviewComplete(gated, {
        [operationKey(ADD)]: accept(),
        [operationKey(RETIRE)]: { decision: "reject", decidedAt: DECIDED_AT },
      }),
    ).toBe(true);
  });
});
