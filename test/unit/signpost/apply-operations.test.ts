// What each operation does to the corpus before anything is written.
//
// The cases that matter are the ones where a wrong answer is silent: a
// reinforce that overwrites the claim it was only meant to corroborate, a
// refine that erases a claim by writing an absent one over it, a supersede
// that deletes the history it replaces, and an operation naming a signpost
// that is not there.

import { describe, expect, it } from "vitest";
import { applyOperations, signpostPath } from "../../../src/core/signpost/apply-operations.js";
import type { Operation } from "../../../src/core/contracts/graph.js";
import type { Signpost } from "../../../src/core/signpost/schema.js";

const TODAY = "2026-09-05";

function signpost(overrides: Partial<Signpost> = {}): Signpost {
  return {
    id: "staging-read-only",
    claim: "Staging is read only outside the ETL window",
    category: "environment",
    scope: { repo: "acme/api" },
    evidence: "A migration failed with a permissions error.",
    confidence: 0.9,
    provenance: {
      session_ids: ["sess-1"],
      authors: ["dev@acme.example"],
      first_seen: "2026-01-01",
      last_reinforced: "2026-01-01",
    },
    status: "active",
    ...overrides,
  };
}

function apply(corpus: Signpost[], operations: Operation[]) {
  return applyOperations({ corpus, operations, now: TODAY });
}

describe("signpostPath", () => {
  it("files a signpost under its category", () => {
    expect(signpostPath(signpost())).toBe("environment/staging-read-only.md");
  });
});

describe("add", () => {
  it("appends the new signpost and marks it changed", () => {
    const added = signpost({ id: "etl-window", claim: "The ETL window is 02:00 to 04:00 UTC" });

    const result = apply([signpost()], [{ op: "add", signpost: added }]);

    expect(result.corpus.map((s) => s.id)).toEqual(["staging-read-only", "etl-window"]);
    expect(result.changed).toEqual(["etl-window"]);
  });

  it("leaves everything it did not touch out of `changed`", () => {
    const result = apply([signpost()], []);

    expect(result.changed).toEqual([]);
    expect(result.corpus).toEqual([signpost()]);
  });
});

describe("reinforce", () => {
  const reinforce: Operation = {
    op: "reinforce",
    id: "staging-read-only",
    sessionId: "sess-2",
    author: "other@acme.example",
  };

  it("adds the session and author, and dates the reinforcement", () => {
    const result = apply([signpost()], [reinforce]);

    expect(result.corpus[0]?.provenance).toEqual({
      session_ids: ["sess-1", "sess-2"],
      authors: ["dev@acme.example", "other@acme.example"],
      first_seen: "2026-01-01",
      last_reinforced: TODAY,
    });
  });

  it("changes nothing about the claim itself", () => {
    const result = apply([signpost()], [reinforce]);

    expect(result.corpus[0]?.claim).toBe(signpost().claim);
    expect(result.corpus[0]?.evidence).toBe(signpost().evidence);
    expect(result.corpus[0]?.confidence).toBe(signpost().confidence);
  });

  it("does not record the same session or author twice", () => {
    const result = apply(
      [signpost()],
      [{ op: "reinforce", id: "staging-read-only", sessionId: "sess-1", author: "dev@acme.example" }],
    );

    expect(result.corpus[0]?.provenance.session_ids).toEqual(["sess-1"]);
    expect(result.corpus[0]?.provenance.authors).toEqual(["dev@acme.example"]);
  });
});

describe("refine", () => {
  it("replaces only what the operation names", () => {
    const result = apply(
      [signpost()],
      [{ op: "refine", id: "staging-read-only", claim: "Staging is read only at all times" }],
    );

    expect(result.corpus[0]?.claim).toBe("Staging is read only at all times");
    expect(result.corpus[0]?.evidence).toBe(signpost().evidence);
    expect(result.corpus[0]?.scope).toEqual(signpost().scope);
  });

  it("replaces the evidence alone when that is all it names", () => {
    const result = apply(
      [signpost()],
      [{ op: "refine", id: "staging-read-only", evidence: "Confirmed with the platform team." }],
    );

    expect(result.corpus[0]?.evidence).toBe("Confirmed with the platform team.");
    expect(result.corpus[0]?.claim).toBe(signpost().claim);
  });

  it("narrows a scope without touching the claim", () => {
    // What a contradiction resolved `both_scoped` produces: the old claim
    // stays true, under a narrower scope.
    const result = apply(
      [signpost()],
      [{ op: "refine", id: "staging-read-only", scope: { repo: "acme/api", paths: ["db/**"] } }],
    );

    expect(result.corpus[0]?.claim).toBe(signpost().claim);
    expect(result.corpus[0]?.scope).toEqual({ repo: "acme/api", paths: ["db/**"] });
  });
});

describe("supersede", () => {
  const replacement = signpost({
    id: "staging-writable-in-window",
    claim: "Staging accepts writes during the ETL window",
    supersedes: ["staging-read-only"],
  });

  it("keeps the old signpost as history rather than deleting it", () => {
    const result = apply([signpost()], [{ op: "supersede", id: "staging-read-only", replacement }]);

    expect(result.corpus.map((s) => s.id)).toEqual(["staging-read-only", "staging-writable-in-window"]);
    expect(result.corpus[0]?.status).toBe("superseded");
    expect(result.corpus[0]?.claim).toBe(signpost().claim);
  });

  it("writes both files", () => {
    const result = apply([signpost()], [{ op: "supersede", id: "staging-read-only", replacement }]);

    expect(result.changed).toEqual(["staging-read-only", "staging-writable-in-window"]);
  });
});

describe("an operation naming something that is not there", () => {
  it.each([
    ["reinforce", { op: "reinforce", id: "gone", sessionId: "s", author: "a" }],
    ["refine", { op: "refine", id: "gone", claim: "x" }],
    ["supersede", { op: "supersede", id: "gone", replacement: signpost({ id: "new" }) }],
  ] as const)("throws for %s rather than writing the rest", (_label, operation) => {
    expect(() => apply([signpost()], [operation as Operation])).toThrow(
      /names gone, which is not in \.signposts\//,
    );
  });
});

describe("retire", () => {
  it("refuses, because nothing has decided what a retired file looks like", () => {
    expect(() =>
      apply([signpost()], [{ op: "retire", id: "staging-read-only", reason: "no longer true" }]),
    ).toThrow(/retire has no write semantics/);
  });
});
