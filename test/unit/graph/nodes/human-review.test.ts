// Node 9's re-entrancy. LangGraph re-executes an interrupted node from the top
// on resume, so the node has to recognise decisions that already landed —
// otherwise a resumed run halts again on the answers it was given.
//
// `interrupt()` throws outside a running graph, which is what makes "did it
// halt?" observable here without compiling a graph at all.

import { describe, expect, it } from "vitest";
import {
  humanReviewNode,
  parseReviewResponse,
  reviewResponseSchema,
} from "../../../../src/graph/nodes/human-review.js";
import { operationKey } from "../../../../src/core/graph/decisions.js";
import { graphState } from "../../../behaviour/helpers/graph-harness.js";
import type { HumanDecision, Operation } from "../../../../src/core/contracts/graph.js";

const RETIRE: Operation = { op: "retire", id: "staging-writable", reason: "Superseded." };
const REFINE: Operation = { op: "refine", sessionId: "sess-r", author: "greg@example.com", id: "etl-window", evidence: "Narrowed." };

const ACCEPT: HumanDecision = { decision: "accept", decidedAt: "2026-08-27T09:00:00.000Z" };

const gatedWith = (...operations: Operation[]) => ({
  auto: [],
  needsHuman: operations.map((operation) => ({ operation, reason: "edits_existing" as const })),
});

describe("when every gated operation has been answered", () => {
  it("returns the decisions without halting", () => {
    const decisions = { [operationKey(RETIRE)]: ACCEPT };
    const state = graphState({ gated: gatedWith(RETIRE), humanDecisions: decisions });

    expect(humanReviewNode(state)).toEqual({ humanDecisions: decisions });
  });

  it("returns without halting when there was nothing to review at all", () => {
    expect(humanReviewNode(graphState())).toEqual({ humanDecisions: {} });
  });
});

describe("when an answer is still missing", () => {
  // The partial-review case. Answering one of two and stopping used to write
  // the single decision and fall through to `commit`, ending the thread with
  // the other operation silently discarded.
  it("halts rather than continuing with a partial review", () => {
    const state = graphState({
      gated: gatedWith(RETIRE, REFINE),
      humanDecisions: { [operationKey(RETIRE)]: ACCEPT },
    });

    expect(() => humanReviewNode(state)).toThrow();
  });

  it("halts when nothing has been answered", () => {
    expect(() => humanReviewNode(graphState({ gated: gatedWith(RETIRE) }))).toThrow();
  });
});

describe("the resume payload", () => {
  it("accepts a well-formed set of decisions", () => {
    expect(reviewResponseSchema.safeParse({ [operationKey(RETIRE)]: ACCEPT }).success).toBe(true);
  });

  // The guarantee applyDecisions' comment claims: an "edit" without a
  // replacement is rejected here rather than quietly committing the original.
  it("rejects an edit that carries no replacement", () => {
    const parsed = reviewResponseSchema.safeParse({
      [operationKey(RETIRE)]: { decision: "edit", decidedAt: "2026-08-30" },
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects a decision that is not one of the three words", () => {
    const parsed = reviewResponseSchema.safeParse({
      [operationKey(RETIRE)]: { decision: "maybe", decidedAt: "2026-08-30" },
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects a payload that is not a record at all", () => {
    expect(reviewResponseSchema.safeParse("accept").success).toBe(false);
  });
});

// 18-end-to-end-gaps.md item 3. The resume value is keyed by `operationKey`
// and the payload carried no key, so the only identifiers an answerer had were
// the signpost ids. Answering with those was accepted and discarded, and the
// node re-halted on the same operations at exit 0 — an agent following
// SKILL.md loops there forever.
//
// The message is the product: everything needed to answer has to be in what
// asked, so an answer that is wrong has to say what the right one looks like.
describe("a decision that answers no gated operation", () => {
  const gated = gatedWith(RETIRE, REFINE);

  it("names the key that matched nothing", () => {
    expect(() => parseReviewResponse({ "staging-writable": ACCEPT }, gated)).toThrow(
      "human_review: no gated operation is keyed staging-writable",
    );
  });

  it("names every one of them, not just the first", () => {
    expect(() =>
      parseReviewResponse({ "staging-writable": ACCEPT, "etl-window": ACCEPT }, gated),
    ).toThrow("no gated operation is keyed staging-writable, etl-window");
  });

  it("says what a key should have looked like, listing the outstanding ones", () => {
    expect(() => parseReviewResponse({ nonsense: ACCEPT }, gated)).toThrow(
      "answer under the `key` each needsHuman entry carries " +
        `(expected one of: ${operationKey(RETIRE)}, ${operationKey(REFINE)})`,
    );
  });

  it("accepts the keys the halt actually asked under", () => {
    const answered = { [operationKey(RETIRE)]: ACCEPT, [operationKey(REFINE)]: ACCEPT };

    expect(parseReviewResponse(answered, gated)).toEqual(answered);
  });
});
