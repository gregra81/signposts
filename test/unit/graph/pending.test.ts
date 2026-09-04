import { describe, expect, it } from "vitest";
import { pendingSignposts } from "../../../src/core/graph/pending.js";
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
const REFINE: Operation = { op: "refine", id: "staging-writable", claim: "Narrower" };
const RETIRE: Operation = { op: "retire", id: "staging-writable", reason: "obsolete" };

function gated(overrides: Partial<GatedOperations> = {}): GatedOperations {
  return { auto: [], needsHuman: [], ...overrides };
}

describe("pendingSignposts", () => {
  it("indexes the signpost an add would create", () => {
    expect(pendingSignposts(gated({ auto: [ADD] }))).toEqual([signpost("staging-read-only")]);
  });

  it("indexes a supersede's replacement, not the claim it replaces", () => {
    expect(pendingSignposts(gated({ auto: [SUPERSEDE] }))).toEqual([
      signpost("staging-read-only-now"),
    ]);
  });

  // These three touch a signpost the index already has, or remove one; none
  // of them carries a signpost to index. See the module comment.
  it.each([
    ["reinforce", REINFORCE],
    ["refine", REFINE],
    ["retire", RETIRE],
  ])("indexes nothing for a %s", (_name, operation) => {
    expect(pendingSignposts(gated({ auto: [operation] }))).toEqual([]);
  });

  // A person may sit on a gated operation for days. Leaving it out would make
  // the claim invisible to every later session in the run, which is the
  // duplicate this exists to prevent.
  it("indexes what a human has yet to approve as well as what auto-published", () => {
    const partition = gated({
      auto: [ADD],
      needsHuman: [{ operation: SUPERSEDE, reason: "edits_existing" }],
    });

    expect(pendingSignposts(partition).map((entry) => entry.id)).toEqual([
      "staging-read-only",
      "staging-read-only-now",
    ]);
  });

  it("indexes nothing for a session that proposed nothing", () => {
    expect(pendingSignposts(gated())).toEqual([]);
  });
});
