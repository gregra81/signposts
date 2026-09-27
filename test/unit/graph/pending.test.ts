import { describe, expect, it } from "vitest";
import { pendingProposals } from "../../../src/core/graph/pending.js";
import type { GatedOperations, Operation } from "../../../src/core/contracts/graph.js";
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

const ADD: Operation = { op: "add", signpost: signpost("staging-read-only") };
const SUPERSEDE: Operation = {
  op: "supersede",
  id: "staging-writable",
  replacement: signpost("staging-read-only-now"),
};
const REINFORCE: Operation = {
  op: "reinforce",
  id: "staging-writable",
  sessionId: "s1",
  author: "dev@acme.example",
};
const REFINE: Operation = { op: "refine", sessionId: "sess-r", author: "greg@example.com", id: "staging-writable", claim: "Narrower" };
const RETIRE: Operation = { op: "retire", id: "staging-writable", reason: "obsolete" };

function gated(overrides: Partial<GatedOperations> = {}): GatedOperations {
  return { auto: [], needsHuman: [], ...overrides };
}

describe("pendingProposals", () => {
  it("indexes the signpost an add would create", () => {
    expect(pendingProposals(gated({ auto: [ADD] }))).toEqual([
      { signpost: signpost("staging-read-only"), state: "in_pr" },
    ]);
  });

  // reinforce, refine and retire touch a signpost the index already has or
  // remove one; none carries a signpost to index. A supersede's replacement is
  // left out for a different reason — indexing it alongside the still-active
  // claim it replaces shows the next session both halves of a contradiction.
  // See the module comment.
  it.each([
    ["reinforce", REINFORCE],
    ["refine", REFINE],
    ["retire", RETIRE],
    ["supersede", SUPERSEDE],
  ])("indexes nothing for a %s", (_name, operation) => {
    expect(pendingProposals(gated({ auto: [operation] }))).toEqual([]);
  });

  // Changed with "Fewer human steps" (19-value-to-a-user.md): a gated
  // operation was held in an in-session review and indexed as
  // `awaiting_review`. It is committed with the rest now, flagged in the pull
  // request, so both halves are in the branch and both are `in_pr`.
  it("indexes the gated half as in the pull request too", () => {
    const held: Operation = { op: "add", signpost: signpost("etl-window") };
    const partition = gated({
      auto: [ADD],
      needsHuman: [{ operation: held, reason: "low_confidence" }],
    });

    expect(pendingProposals(partition)).toEqual([
      { signpost: signpost("staging-read-only"), state: "in_pr" },
      { signpost: signpost("etl-window"), state: "in_pr" },
    ]);
  });

  it("indexes nothing for a session that proposed nothing", () => {
    expect(pendingProposals(gated())).toEqual([]);
  });
});
