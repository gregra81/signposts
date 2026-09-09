import { describe, expect, it } from "vitest";
import { buildOperations } from "../../../src/core/graph/operations.js";
import type {
  Candidate,
  Classification,
  Resolution,
} from "../../../src/core/contracts/graph.js";

const NOW = "2026-08-27";
const SESSION = "sess-1";
const AUTHOR = "dev@acme.example";

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    tempId: "t1",
    claim: "Staging is read only",
    category: "environment",
    scope: { repo: "acme/api" },
    evidence: "Stated after a failed write.",
    confidence: 0.9,
    hedged: false,
    ...overrides,
  };
}

function build(
  candidates: Candidate[],
  classifications: Record<string, Classification>,
  resolutions: Record<string, Resolution> = {},
  existingIds: string[] = ["staging-is-read-only-old"],
) {
  return buildOperations({
    candidates,
    classifications,
    resolutions,
    sessionId: SESSION,
    author: AUTHOR,
    now: NOW,
    existingIds: new Set(existingIds),
  });
}

describe("buildOperations", () => {
  it("turns NOVEL into an add carrying the candidate's content and provenance", () => {
    const built = build([candidate()], {
      t1: { tempId: "t1", kind: "NOVEL", rationale: "nothing like it" },
    });
    expect(built).toHaveLength(1);
    expect(built[0]).toMatchObject({ tempId: "t1", confidence: 0.9 });
    const [operation] = built[0]!.operations;
    expect(operation).toEqual({
      op: "add",
      signpost: {
        id: "staging-is-read-only",
        claim: "Staging is read only",
        category: "environment",
        scope: { repo: "acme/api" },
        evidence: "Stated after a failed write.",
        confidence: 0.9,
        provenance: {
          session_ids: [SESSION],
          authors: [AUTHOR],
          first_seen: NOW,
          last_reinforced: NOW,
        },
        status: "active",
      },
    });
  });

  // 04's acceptance criterion: a duplicate produces a reinforce, not a second file.
  it("turns DUPLICATE into a reinforce, never a second add", () => {
    const built = build([candidate()], {
      t1: { tempId: "t1", kind: "DUPLICATE", relatedId: "staging-is-read-only-old", rationale: "same" },
    });
    expect(built[0]?.operations).toEqual([
      { op: "reinforce", id: "staging-is-read-only-old", sessionId: SESSION, author: AUTHOR },
    ]);
  });

  it("turns REFINEMENT into a refine of the related signpost", () => {
    const built = build([candidate()], {
      t1: { tempId: "t1", kind: "REFINEMENT", relatedId: "staging-is-read-only-old", rationale: "sharper" },
    });
    expect(built[0]?.operations).toEqual([
      {
        op: "refine",
        id: "staging-is-read-only-old",
        claim: "Staging is read only",
        evidence: "Stated after a failed write.",
        scope: { repo: "acme/api" },
      },
    ]);
  });

  it("turns a new_wins contradiction into a supersede that records what it replaced", () => {
    const built = build(
      [candidate()],
      { t1: { tempId: "t1", kind: "CONTRADICTION", relatedId: "staging-is-read-only-old", rationale: "opposite" } },
      { t1: { tempId: "t1", outcome: "new_wins", reasoning: "config changed in March" } },
    );
    const [operation] = built[0]!.operations;
    expect(operation).toMatchObject({ op: "supersede", id: "staging-is-read-only-old" });
    expect(operation).toHaveProperty("replacement.supersedes", ["staging-is-read-only-old"]);
  });

  it("produces nothing when the existing claim wins", () => {
    const built = build(
      [candidate()],
      { t1: { tempId: "t1", kind: "CONTRADICTION", relatedId: "staging-is-read-only-old", rationale: "opposite" } },
      {
        t1: {
          tempId: "t1",
          outcome: "existing_wins",
          reasoning: "the new claim is a special case",
          // Scopes are present but must be ignored: falling through to the
          // both_scoped branch would emit a refine and an add here.
          newScope: { repo: "acme/api", paths: ["etl/**"] },
          existingScope: { repo: "acme/api", paths: ["web/**"] },
        },
      },
    );
    expect(built).toEqual([]);
  });

  it("narrows the existing scope and adds the new one for both_scoped", () => {
    const built = build(
      [candidate()],
      { t1: { tempId: "t1", kind: "CONTRADICTION", relatedId: "staging-is-read-only-old", rationale: "scoped" } },
      {
        t1: {
          tempId: "t1",
          outcome: "both_scoped",
          reasoning: "different access paths",
          newScope: { repo: "acme/api", paths: ["etl/**"] },
          existingScope: { repo: "acme/api", paths: ["web/**"] },
        },
      },
    );
    expect(built[0]?.operations).toHaveLength(2);
    expect(built[0]?.operations[0]).toEqual({
      op: "refine",
      id: "staging-is-read-only-old",
      scope: { repo: "acme/api", paths: ["web/**"] },
    });
    expect(built[0]?.operations[1]).toHaveProperty("signpost.scope.paths", ["etl/**"]);
  });

  it("emits nothing for both_scoped missing one of its scopes", () => {
    const built = build(
      [candidate()],
      { t1: { tempId: "t1", kind: "CONTRADICTION", relatedId: "staging-is-read-only-old", rationale: "scoped" } },
      {
        t1: {
          tempId: "t1",
          outcome: "both_scoped",
          reasoning: "different access paths",
          newScope: { repo: "acme/api", paths: ["etl/**"] },
        },
      },
    );
    expect(built).toEqual([]);
  });

  // Undecidable is a first-class outcome. The candidate survives as an add so
  // a person can decide; it must never be dropped silently.
  it("keeps an undecidable contradiction alive as an add", () => {
    const built = build(
      [candidate()],
      { t1: { tempId: "t1", kind: "CONTRADICTION", relatedId: "staging-is-read-only-old", rationale: "opposite" } },
      { t1: { tempId: "t1", outcome: "undecidable", reasoning: "no evidence either way" } },
    );
    expect(built[0]?.operations[0]).toMatchObject({ op: "add" });
  });

  it("treats a contradiction with no resolution at all like undecidable", () => {
    const built = build([candidate()], {
      t1: { tempId: "t1", kind: "CONTRADICTION", relatedId: "staging-is-read-only-old", rationale: "opposite" },
    });
    expect(built[0]?.operations[0]).toMatchObject({ op: "add" });
  });

  // OBSOLETE is the trigger `retire` never had (03-memory-model.md
  // "Lifecycle"): a candidate that withdraws a neighbour without replacing it.
  it("turns OBSOLETE into a retire against the neighbour", () => {
    const built = build([candidate()], {
      t1: {
        tempId: "t1",
        kind: "OBSOLETE",
        relatedId: "staging-is-read-only-old",
        rationale: "The replica was dropped entirely in March.",
      },
    });

    expect(built).toHaveLength(1);
    expect(built[0]?.operations).toEqual([
      {
        op: "retire",
        id: "staging-is-read-only-old",
        reason: "The replica was dropped entirely in March.",
      },
    ]);
  });

  // The distinction the prompt draws: OBSOLETE withdraws, CONTRADICTION
  // competes. Only the second one records a claim of its own, so only the
  // second one can produce an `add`.
  it("adds nothing of its own for OBSOLETE, unlike a resolved contradiction", () => {
    const built = build([candidate()], {
      t1: { tempId: "t1", kind: "OBSOLETE", relatedId: "staging-is-read-only-old", rationale: "gone" },
    });

    expect(built[0]?.operations.map((operation) => operation.op)).toEqual(["retire"]);
  });

  it.each(["DUPLICATE", "REFINEMENT", "OBSOLETE"] as const)(
    "emits nothing for %s with no relatedId",
    (kind) => {
      const built = build([candidate()], { t1: { tempId: "t1", kind, rationale: "r" } });
      expect(built).toEqual([]);
    },
  );

  it("emits nothing for a settled contradiction with no relatedId", () => {
    const built = build(
      [candidate()],
      { t1: { tempId: "t1", kind: "CONTRADICTION", rationale: "r" } },
      { t1: { tempId: "t1", outcome: "new_wins", reasoning: "r" } },
    );
    expect(built).toEqual([]);
  });

  // An unclassified candidate means its fan-out branch never finished.
  // Guessing `add` would risk writing a duplicate.
  it("skips a candidate with no classification", () => {
    expect(build([candidate()], {})).toEqual([]);
  });

  it("does not hand two candidates the same slug", () => {
    const built = build(
      [candidate({ tempId: "a" }), candidate({ tempId: "b" })],
      {
        a: { tempId: "a", kind: "NOVEL", rationale: "r" },
        b: { tempId: "b", kind: "NOVEL", rationale: "r" },
      },
      {},
      [],
    );
    const ids = built.flatMap((c) =>
      c.operations.map((o) => (o.op === "add" ? o.signpost.id : "")),
    );
    expect(new Set(ids).size).toBe(2);
  });

  it("does not reuse an id already on disk", () => {
    const built = build(
      [candidate()],
      { t1: { tempId: "t1", kind: "NOVEL", rationale: "r" } },
      {},
      ["staging-is-read-only"],
    );
    expect(built[0]?.operations[0]).toHaveProperty("signpost.id");
    expect(built[0]?.operations[0]).not.toHaveProperty("signpost.id", "staging-is-read-only");
  });

  it("carries each candidate's own confidence through for the gate", () => {
    const built = build(
      [candidate({ tempId: "a", confidence: 0.4 }), candidate({ tempId: "b", claim: "Other claim", confidence: 0.95 })],
      {
        a: { tempId: "a", kind: "NOVEL", rationale: "r" },
        b: { tempId: "b", kind: "NOVEL", rationale: "r" },
      },
    );
    expect(built.map((c) => c.confidence)).toEqual([0.4, 0.95]);
  });
});
