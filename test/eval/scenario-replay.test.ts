// Scenario replay: extraction quality checked end to end, with no model call
// (09-evaluation.md, "Fixture replay").
//
// Each scenario is an ordered list of synthetic sessions over one repo. Step N
// runs the real graph against the mirror steps 1..N-1 produced, answering every
// model call from a reply recorded once under `fixtures/`. So a change to the
// gutter, the redactor, the graph's routing, the gate or `applyOperations`
// shows up here as a different set of operations, offline and for free.
//
// What it cannot judge is a prompt. Fixtures are keyed on the exact system and
// user turns, so editing a prompt misses every one of them and the suite fails
// with FixtureModelProvider's "no fixture recorded" error. That failure is the
// intended signal: the change needs re-recording and a person looking at what
// the model now says, not a green run.
//
// Graded two ways, both deterministic (09-evaluation.md, "Grading"):
//
// - Structurally, on operations and mirror size — never on the classification
//   kind. The kind is the model's judgement, recorded in the fixture;
//   asserting it would reward editing a transcript until the model agreed with
//   its label.
// - Semantically, on `expect_claims`: each gist is what the human in the
//   session actually said, and some claim the step produced has to land within
//   CLAIM_MATCH_MIN_SIMILARITY of it under the local embedding model. Wording
//   varies between recordings, so exact matching would be useless; this is the
//   check that a re-record still says the same thing.
//
// Every transcript is synthetic, written for the case it exercises. A real
// session does not belong here: redaction removes secrets, not the
// confidential context that makes a correction worth learning from.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";
import { EMBEDDING_MODEL } from "../../src/core/config/constants.ts";
import { OPERATION_TAGS, type Operation } from "../../src/core/contracts/graph.ts";
import { cosineSimilarity } from "../../src/core/retrieval/cosine-similarity.ts";
import { applyOperations } from "../../src/core/signpost/apply-operations.ts";
import { ACTIVE_STATUS, type Signpost } from "../../src/core/signpost/schema.ts";
import { buildExtractionGraph, startRun } from "../../src/graph/index.ts";
import { createEmbedder, type Embedder } from "../../src/io/embed/embedder.ts";
import { gutterSession } from "../../src/io/gutter/session.ts";
import { FixtureModelProvider, fixtureKey } from "../../src/io/model/fixture-provider.ts";
import type { NodeName } from "../../src/core/model/types.ts";
import type { GraphPorts } from "../../src/graph/index.ts";
import { testLocalModelPath, testModelCache } from "../support/model-cache.ts";

const HERE = import.meta.dirname;
const SCENARIOS = path.join(HERE, "scenarios");
const FIXTURES = path.join(HERE, "fixtures");

// The clock and author the fixtures were recorded under. Either one reaches a
// user turn, so changing it misses every fixture.
const NOW = new Date("2026-08-31T00:00:00.000Z");
const AUTHOR = "eval@signposts.local";
const REPO_ROOT = "/repo";

/** 09-evaluation.md: at least a third of cases must produce nothing. */
const MIN_NEGATIVE_RATIO = 1 / 3;

/** 09-evaluation.md, "Grading": semantic match requires cosine ≥ 0.8. */
const CLAIM_MATCH_MIN_SIMILARITY = 0.8;

/** Loading the model from the local copy takes seconds, not the default 5s budget. */
const EMBEDDER_LOAD_TIMEOUT_MS = 120_000;

interface Step {
  transcript: string;
  expect_operations?: string[];
  expect_mirror_size?: number;
  /** What the human said, one gist per claim the step must produce. */
  expect_claims?: string[];
}

interface Scenario {
  name: string;
  repo: string;
  steps: Step[];
}

interface FixtureRecord {
  node: NodeName;
  system: string;
  user: string;
  value: unknown;
}

function loadScenarios(): Scenario[] {
  return readdirSync(SCENARIOS)
    .sort()
    .map((name) => {
      const spec = parseYaml(readFileSync(path.join(SCENARIOS, name, "scenario.yaml"), "utf8")) as Omit<
        Scenario,
        "name"
      >;
      return { name, ...spec };
    });
}

function loadFixtures(): Record<string, unknown> {
  const fixtures: Record<string, unknown> = {};
  for (const name of readdirSync(FIXTURES)) {
    const record = JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8")) as FixtureRecord;
    fixtures[fixtureKey(record.node, record.system, record.user)] = record.value;
  }
  return fixtures;
}

/**
 * Neighbour and index ports over the mirror a scenario has built so far.
 *
 * `find` returns every active signpost for the repo rather than ranking them:
 * the neighbour list is part of the classify prompt, so it has to be exactly
 * the list the fixtures were recorded against. Ranking has its own tests.
 */
function mirrorPorts(mirror: readonly Signpost[]): Pick<GraphPorts, "neighbours" | "index"> {
  const active = (repo: string) => mirror.filter((s) => s.scope.repo === repo && s.status === ACTIVE_STATUS);
  return {
    neighbours: { find: async (repo) => active(repo) },
    index: {
      existingIds: async (repo) => new Set(mirror.filter((s) => s.scope.repo === repo).map((s) => s.id)),
      isBootstrap: async (repo) => active(repo).length === 0,
      byId: async (repo, id) => mirror.find((s) => s.id === id && s.scope.repo === repo),
    },
  };
}

/** The claim text each operation writes. `reinforce` and `retire` write none. */
function claimsOf(operations: readonly Operation[]): string[] {
  return operations.flatMap((operation) => {
    switch (operation.op) {
      case OPERATION_TAGS.add:
        return [operation.signpost.claim];
      case OPERATION_TAGS.refine:
        return operation.claim === undefined ? [] : [operation.claim];
      case OPERATION_TAGS.supersede:
        return [operation.replacement.claim];
      default:
        return [];
    }
  });
}

const scenarios = loadScenarios();
const fixtures = loadFixtures();

describe("scenario replay", () => {
  let embedder: Embedder;

  beforeAll(async () => {
    embedder = await createEmbedder({
      modelCacheDir: testModelCache(),
      allowRemoteModels: false,
      localModelPath: testLocalModelPath(),
      embeddingModel: EMBEDDING_MODEL,
    });
  }, EMBEDDER_LOAD_TIMEOUT_MS);

  /** Fails naming the gist and the closest claim, so a miss says what drifted. */
  async function expectClaimsMatch(transcript: string, gists: readonly string[], claims: readonly string[]) {
    expect(claims.length, `${transcript} produced no claim to match ${gists.length} gist(s)`).toBeGreaterThan(0);
    const vectors = await embedder.embed([...gists, ...claims]);
    const gistVectors = vectors.slice(0, gists.length);
    const claimVectors = vectors.slice(gists.length);

    gists.forEach((gist, i) => {
      const scored = claimVectors.map((vector, j) => ({
        claim: claims[j]!,
        similarity: cosineSimilarity(gistVectors[i]!, vector),
      }));
      const best = scored.reduce((a, b) => (b.similarity > a.similarity ? b : a));
      expect(
        best.similarity,
        `${transcript}: "${gist}" — closest claim was "${best.claim}" at ${best.similarity.toFixed(3)}`,
      ).toBeGreaterThanOrEqual(CLAIM_MATCH_MIN_SIMILARITY);
    });
  }

  it("keeps at least a third of steps negative", () => {
    const steps = scenarios.flatMap((scenario) => scenario.steps);
    const negative = steps.filter((step) => (step.expect_operations ?? []).length === 0);
    expect(negative.length / steps.length).toBeGreaterThanOrEqual(MIN_NEGATIVE_RATIO);
  });

  it.each(scenarios)("$name replays as a sequence", async ({ name, repo, steps }) => {
    let mirror: Signpost[] = [];

    for (const step of steps) {
      const transcriptPath = path.join(SCENARIOS, name, step.transcript);
      const scope = { repo, repoRoot: REPO_ROOT };
      const ports: GraphPorts = {
        model: new FixtureModelProvider(fixtures),
        gutter: { gutter: (p) => gutterSession(p, scope) },
        // A pinned copy, never the repo's live CLAUDE.md: the critic's user
        // turn is part of every fixture key, so reading the real file would
        // make an edit to it miss every recorded critic reply.
        conventions: { read: async () => readFileSync(path.join(HERE, "conventions.md"), "utf8") },
        ...mirrorPorts(mirror),
        pendingIndex: { indexPending: async () => {}, clear: async () => {} },
        commit: { apply: async () => {} },
        author: AUTHOR,
        now: () => NOW,
      };
      const checkpointer = new MemorySaver();
      const graph = buildExtractionGraph({ ports, checkpointer });
      const session = await gutterSession(transcriptPath, scope);

      const result = await startRun(graph, checkpointer, {
        repo,
        sessionId: session.sessionId,
        contentHash: session.contentHash,
        repoRoot: REPO_ROOT,
        transcriptPath,
      });

      // No reviewer here, so what the gate held is approved: otherwise nothing
      // lands and every later step sees an empty mirror.
      const gated = result.state.gated ?? { auto: [], needsHuman: [] };
      const operations: Operation[] = [...gated.auto, ...gated.needsHuman.map((held) => held.operation)];
      mirror = applyOperations({
        corpus: mirror,
        operations,
        now: NOW.toISOString().slice(0, "YYYY-MM-DD".length),
      }).corpus;

      expect(operations.map((operation) => operation.op).sort(), `${step.transcript} operations`).toEqual(
        [...(step.expect_operations ?? [])].sort(),
      );
      if (step.expect_mirror_size !== undefined) {
        expect(mirror.length, `${step.transcript} mirror size`).toBe(step.expect_mirror_size);
      }
      if (step.expect_claims !== undefined) {
        await expectClaimsMatch(step.transcript, step.expect_claims, claimsOf(operations));
      }
    }
  });
});
