// What the reviewer typed, and what an edit leaves behind.
//
// The pair these tests keep apart is reject and skip. Both stop the operation
// today; only one of them stops it coming back tomorrow, and the code that
// tells them apart is a switch over five words that a typo must never fall
// through.

import { describe, expect, it } from "vitest";
import { OPERATION_TAGS } from "../../../src/core/contracts/graph.js";
import {
  editableText,
  isEditable,
  parseReviewChoice,
  REVIEW_CHOICES,
  withEdits,
} from "../../../src/core/review/answer.js";
import type { Operation } from "../../../src/core/contracts/graph.js";
import type { Signpost } from "../../../src/core/signpost/schema.js";

const SIGNPOST: Signpost = {
  id: "staging-read-only",
  claim: "Staging is read only outside the ETL window",
  category: "environment",
  scope: { repo: "acme/api" },
  evidence: "A migration against staging was refused.",
  confidence: 0.9,
  provenance: {
    session_ids: ["sess-1"],
    authors: ["dev@acme.example"],
    first_seen: "2026-09-01",
    last_reinforced: "2026-09-01",
  },
  status: "active",
};

const ADD: Operation = { op: OPERATION_TAGS.add, signpost: SIGNPOST };
const SUPERSEDE: Operation = {
  op: OPERATION_TAGS.supersede,
  id: "staging-writable",
  replacement: SIGNPOST,
};
const REFINE: Operation = {
  op: OPERATION_TAGS.refine,
  id: "staging-writable",
  claim: "Staging is writable only at night",
  evidence: "Narrowed after the ETL change.",
};
const RETIRE: Operation = { op: OPERATION_TAGS.retire, id: "staging-writable", reason: "Obsolete." };
const REINFORCE: Operation = {
  op: OPERATION_TAGS.reinforce,
  id: "staging-writable",
  sessionId: "sess-1",
  author: "dev@acme.example",
};

describe("parseReviewChoice", () => {
  it.each([
    ["a", REVIEW_CHOICES.accept],
    ["r", REVIEW_CHOICES.reject],
    ["e", REVIEW_CHOICES.edit],
    ["s", REVIEW_CHOICES.skip],
    ["q", REVIEW_CHOICES.quit],
  ])("reads %s as %s", (typed, choice) => {
    expect(parseReviewChoice(typed, true)).toBe(choice);
  });

  it.each(Object.values(REVIEW_CHOICES))("reads the whole word %s", (word) => {
    expect(parseReviewChoice(word, true)).toBe(word);
  });

  it("ignores case and surrounding space", () => {
    expect(parseReviewChoice("  Reject \n", true)).toBe(REVIEW_CHOICES.reject);
  });

  it("keeps reject and skip apart", () => {
    expect(parseReviewChoice("r", true)).not.toBe(parseReviewChoice("s", true));
  });

  it("has no answer for an empty line", () => {
    expect(parseReviewChoice("", true)).toBeUndefined();
  });

  it("has no answer for a word it does not know", () => {
    expect(parseReviewChoice("yes", true)).toBeUndefined();
  });

  it("does not read a prefix as the word it starts", () => {
    expect(parseReviewChoice("acc", true)).toBeUndefined();
  });

  it("refuses edit for an operation with no wording to change", () => {
    expect(parseReviewChoice("e", false)).toBeUndefined();
    expect(parseReviewChoice("edit", false)).toBeUndefined();
  });

  it("still takes every other answer when editing is not on offer", () => {
    expect(parseReviewChoice("a", false)).toBe(REVIEW_CHOICES.accept);
  });
});

describe("isEditable", () => {
  it.each([
    ["add", ADD, true],
    ["supersede", SUPERSEDE, true],
    ["refine", REFINE, true],
    ["retire", RETIRE, false],
    ["reinforce", REINFORCE, false],
  ])("is %s: %s", (_name, operation, expected) => {
    expect(isEditable(operation as Operation)).toBe(expected);
  });
});

describe("editableText", () => {
  it("reads an add's own claim and evidence", () => {
    expect(editableText(ADD)).toEqual({ claim: SIGNPOST.claim, evidence: SIGNPOST.evidence });
  });

  it("reads a supersede's replacement, not the signpost it replaces", () => {
    expect(editableText(SUPERSEDE)).toEqual({ claim: SIGNPOST.claim, evidence: SIGNPOST.evidence });
  });

  it("reads a refine's fields", () => {
    expect(editableText(REFINE)).toEqual({
      claim: "Staging is writable only at night",
      evidence: "Narrowed after the ETL change.",
    });
  });

  it("offers nothing for a scope-only refine", () => {
    expect(editableText({ op: OPERATION_TAGS.refine, id: "staging-writable" })).toEqual({});
  });

  it("offers nothing for an operation with no wording", () => {
    expect(editableText(RETIRE)).toEqual({});
    expect(editableText(REINFORCE)).toEqual({});
  });
});

describe("withEdits", () => {
  it("rewords an add's signpost and nothing else about it", () => {
    const edited = withEdits(ADD, { claim: "Staging is read only" });

    expect(edited).toEqual({
      op: OPERATION_TAGS.add,
      signpost: { ...SIGNPOST, claim: "Staging is read only" },
    });
  });

  it("rewords a supersede's replacement without changing what it replaces", () => {
    const edited = withEdits(SUPERSEDE, { claim: "Staging is read only", evidence: "Retyped." });

    expect(edited).toEqual({
      op: OPERATION_TAGS.supersede,
      id: "staging-writable",
      replacement: { ...SIGNPOST, claim: "Staging is read only", evidence: "Retyped." },
    });
  });

  it("rewords a refine in place", () => {
    expect(withEdits(REFINE, { evidence: "Retyped." })).toEqual({ ...REFINE, evidence: "Retyped." });
  });

  it("leaves alone what the reviewer did not retype", () => {
    expect(withEdits(ADD, {})).toEqual(ADD);
    expect(withEdits(SUPERSEDE, { evidence: "Retyped." })).toMatchObject({
      replacement: { claim: SIGNPOST.claim },
    });
  });

  it("changes nothing for an operation with no wording", () => {
    expect(withEdits(RETIRE, { claim: "anything" })).toEqual(RETIRE);
    expect(withEdits(REINFORCE, { claim: "anything" })).toEqual(REINFORCE);
  });
});
