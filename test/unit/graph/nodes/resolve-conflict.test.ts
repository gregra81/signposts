// Node 6 adjudicates the contradictions nobody has settled yet — and only
// those. Everything here is about which candidates it picks up and which
// lookup answers "the existing claim".

import { describe, expect, it } from "vitest";
import { makeResolveConflictNode } from "../../../../src/graph/nodes/resolve-conflict.js";
import {
  candidate,
  existingSignpost,
  gutteredSession,
  makeHarness,
  graphState,
} from "../../../behaviour/helpers/graph-harness.js";
import type { Classification, Resolution } from "../../../../src/core/contracts/graph.js";

const EXISTING = existingSignpost({ id: "staging-writable" });

const contradiction = (tempId: string, relatedId = EXISTING.id): Classification => ({
  tempId,
  kind: "CONTRADICTION",
  relatedId,
  rationale: "The recorded claim says the opposite.",
});

const novel = (tempId: string): Classification => ({
  tempId,
  kind: "NOVEL",
  rationale: "Nothing like it recorded.",
});

const resolution = (tempId: string): Resolution => ({
  tempId,
  outcome: "new_wins",
  reasoning: "The newer claim was demonstrated.",
});

function nodeWith(options: {
  neighbours?: Record<string, ReturnType<typeof existingSignpost>[]>;
  existing?: ReturnType<typeof existingSignpost>[];
}) {
  const ports = makeHarness({
    script: { resolve: [resolution("t1"), resolution("t2")] },
    session: gutteredSession(),
    existing: options.existing ?? [EXISTING],
  });
  return { ports, node: makeResolveConflictNode(ports) };
}

describe("which candidates it picks up", () => {
  it("resolves the unsettled contradictions and nothing else", async () => {
    const { ports, node } = nodeWith({});

    const update = await node(
      graphState({
        candidates: [candidate({ tempId: "t1" }), candidate({ tempId: "t2" })],
        classifications: { t1: contradiction("t1"), t2: novel("t2") },
        neighbours: { t1: [EXISTING] },
      }),
    );

    expect(ports.model.callsTo("resolve")).toHaveLength(1);
    expect(Object.keys(update.resolutions ?? {})).toEqual(["t1"]);
  });

  it("skips a contradiction that already has a resolution", async () => {
    const { ports, node } = nodeWith({});

    await node(
      graphState({
        candidates: [candidate({ tempId: "t1" })],
        classifications: { t1: contradiction("t1") },
        resolutions: { t1: resolution("t1") },
        neighbours: { t1: [EXISTING] },
      }),
    );

    expect(ports.model.callsTo("resolve")).toHaveLength(0);
  });

  it("resolves every pending contradiction in one pass", async () => {
    const { ports, node } = nodeWith({});

    const update = await node(
      graphState({
        candidates: [candidate({ tempId: "t1" }), candidate({ tempId: "t2" })],
        classifications: { t1: contradiction("t1"), t2: contradiction("t2") },
        neighbours: { t1: [EXISTING], t2: [EXISTING] },
      }),
    );

    expect(ports.model.callsTo("resolve")).toHaveLength(2);
    expect(Object.keys(update.resolutions ?? {}).sort()).toEqual(["t1", "t2"]);
  });
});

// The model echoes a tempId back; two prompts that look alike can come back
// carrying the same one. Filing a resolution under the echoed id would let one
// candidate's adjudication justify a `supersede` of another's signpost.
describe("which candidate a resolution belongs to", () => {
  it("keys on the candidate it asked about, not the tempId the model echoed", async () => {
    const ports = makeHarness({
      script: { resolve: [resolution("t1"), resolution("t1")] },
      session: gutteredSession(),
      existing: [EXISTING],
    });
    const node = makeResolveConflictNode(ports);

    const update = await node(
      graphState({
        candidates: [candidate({ tempId: "t1" }), candidate({ tempId: "t2" })],
        classifications: { t1: contradiction("t1"), t2: contradiction("t2") },
        neighbours: { t1: [EXISTING], t2: [EXISTING] },
      }),
    );

    expect(Object.keys(update.resolutions ?? {}).sort()).toEqual(["t1", "t2"]);
  });
});

describe("finding the existing claim", () => {
  it("uses the candidate's own neighbours without consulting the mirror", async () => {
    const { ports, node } = nodeWith({});

    await node(
      graphState({
        candidates: [candidate({ tempId: "t1" })],
        classifications: { t1: contradiction("t1") },
        neighbours: { t1: [EXISTING] },
      }),
    );

    expect(ports.index.byIdCalls).toEqual([]);
    expect(ports.model.callsTo("resolve")).toHaveLength(1);
  });

  it("falls back to the mirror when the relatedId is not among the neighbours", async () => {
    const { ports, node } = nodeWith({});
    const unrelated = existingSignpost({ id: "something-else" });

    await node(
      graphState({
        candidates: [candidate({ tempId: "t1" })],
        classifications: { t1: contradiction("t1") },
        neighbours: { t1: [unrelated] },
      }),
    );

    expect(ports.index.byIdCalls).toEqual([EXISTING.id]);
    expect(ports.model.callsTo("resolve")).toHaveLength(1);
  });

  it("leaves the contradiction unresolved when the claim cannot be looked up", async () => {
    const { ports, node } = nodeWith({ existing: [] });

    const update = await node(
      graphState({
        candidates: [candidate({ tempId: "t1" })],
        classifications: { t1: contradiction("t1") },
      }),
    );

    expect(ports.model.callsTo("resolve")).toHaveLength(0);
    expect(update.resolutions).toEqual({});
  });

  it("leaves it unresolved when the classification named no relatedId", async () => {
    const { ports, node } = nodeWith({});

    const update = await node(
      graphState({
        candidates: [candidate({ tempId: "t1" })],
        classifications: {
          t1: { tempId: "t1", kind: "CONTRADICTION", rationale: "Conflicts, unclear with what." },
        },
      }),
    );

    expect(ports.index.byIdCalls).toEqual([]);
    expect(ports.model.callsTo("resolve")).toHaveLength(0);
    expect(update.resolutions).toEqual({});
  });

  it("keeps the resolved siblings when one of them could not be looked up", async () => {
    const { node } = nodeWith({});

    const update = await node(
      graphState({
        candidates: [candidate({ tempId: "t1" }), candidate({ tempId: "t2" })],
        classifications: { t1: contradiction("t1"), t2: contradiction("t2", "gone") },
        neighbours: { t1: [EXISTING] },
      }),
    );

    expect(Object.keys(update.resolutions ?? {})).toEqual(["t1"]);
  });
});

// Phase 4.5. The node's job here is small — hand over the tool definitions
// and a runner bound to *this run's* checkout — and getting either wrong is
// the difference between a resolver with evidence and one guessing from text.
describe("the read-only tools", () => {
  it("offers the model all three on every resolve call", async () => {
    const { ports, node } = nodeWith({});

    await node(
      graphState({
        candidates: [candidate({ tempId: "t1" })],
        classifications: { t1: contradiction("t1") },
        neighbours: { t1: [EXISTING] },
      }),
    );

    expect(ports.model.callsTo("resolve")[0]?.tools?.map((tool) => tool.name)).toEqual([
      "read_file",
      "git_log",
      "grep_repo",
    ]);
  });

  it("supplies a runner with them, because tool definitions cannot run themselves", async () => {
    const { ports, node } = nodeWith({});

    await node(
      graphState({
        candidates: [candidate({ tempId: "t1" })],
        classifications: { t1: contradiction("t1") },
        neighbours: { t1: [EXISTING] },
      }),
    );

    expect(ports.model.callsTo("resolve")[0]?.hasRunTool).toBe(true);
  });

  it("binds the runner to graph state's repoRoot, never to anything the model named", async () => {
    const { ports, node } = nodeWith({});

    await node(
      graphState({
        repoRoot: "/checkouts/acme-api",
        candidates: [candidate({ tempId: "t1" }), candidate({ tempId: "t2" })],
        classifications: { t1: contradiction("t1"), t2: contradiction("t2") },
        neighbours: { t1: [EXISTING], t2: [EXISTING] },
      }),
    );

    expect(ports.tools.roots).toEqual(["/checkouts/acme-api", "/checkouts/acme-api"]);
  });

  it("does not build a runner for a contradiction it never adjudicates", async () => {
    const { ports, node } = nodeWith({ existing: [] });

    await node(
      graphState({
        candidates: [candidate({ tempId: "t1" })],
        classifications: { t1: contradiction("t1") },
      }),
    );

    expect(ports.tools.roots).toEqual([]);
  });
});

// "undecidable is a legitimate answer, not a failure" (RESOLVE_SYSTEM). It has
// to travel the same path as every other outcome: recorded in state, keyed to
// its candidate, and never mistaken for the node having failed.
describe("undecidable", () => {
  const undecidable = (tempId: string): Resolution => ({
    tempId,
    outcome: "undecidable",
    reasoning: "The commit history does not say when the change landed.",
  });

  it("is recorded as a resolution like any other outcome", async () => {
    const ports = makeHarness({
      script: { resolve: [undecidable("t1")] },
      session: gutteredSession(),
      existing: [EXISTING],
    });

    const update = await makeResolveConflictNode(ports)(
      graphState({
        candidates: [candidate({ tempId: "t1" })],
        classifications: { t1: contradiction("t1") },
        neighbours: { t1: [EXISTING] },
      }),
    );

    expect(update.resolutions).toEqual({ t1: undecidable("t1") });
  });

  it("does not stop its siblings from being resolved", async () => {
    const ports = makeHarness({
      script: { resolve: [undecidable("t1"), resolution("t2")] },
      session: gutteredSession(),
      existing: [EXISTING],
    });

    const update = await makeResolveConflictNode(ports)(
      graphState({
        candidates: [candidate({ tempId: "t1" }), candidate({ tempId: "t2" })],
        classifications: { t1: contradiction("t1"), t2: contradiction("t2") },
        neighbours: { t1: [EXISTING], t2: [EXISTING] },
      }),
    );

    const resolutions = (update.resolutions ?? {}) as Record<string, Resolution>;
    expect(resolutions.t1?.outcome).toBe("undecidable");
    expect(resolutions.t2?.outcome).toBe("new_wins");
  });

  it("carries evidenceChecked when the model cited what it read", async () => {
    const withEvidence: Resolution = {
      ...undecidable("t1"),
      evidenceChecked: ["src/config.ts", "git log src/config.ts"],
    };
    const ports = makeHarness({
      script: { resolve: [withEvidence] },
      session: gutteredSession(),
      existing: [EXISTING],
    });

    const update = await makeResolveConflictNode(ports)(
      graphState({
        candidates: [candidate({ tempId: "t1" })],
        classifications: { t1: contradiction("t1") },
        neighbours: { t1: [EXISTING] },
      }),
    );

    const resolutions = (update.resolutions ?? {}) as Record<string, Resolution>;
    expect(resolutions.t1?.evidenceChecked).toEqual([
      "src/config.ts",
      "git log src/config.ts",
    ]);
  });
});
