// The multi-session half of the replay suite.
//
// golden-replay.test.ts proves one session runs from fixtures. This proves a
// sequence does: each step runs against the mirror the previous steps
// produced, so what it exercises is memory formation over time — a claim
// added, restated, sharpened, superseded — rather than one session judged
// against a mirror somebody wrote by hand.
//
// Graded on the operations each step produced and the resulting mirror size,
// never on which classification kind the model chose. The kind is the model's
// judgement, recorded in the fixture; asserting it here would reward editing a
// transcript until the model agreed with its label. What must hold is that the
// machinery turns whatever it decided into the right operations.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import { MODEL_CLASSIFY, MODEL_DEFAULT, MODEL_EXTRACT } from "../../../src/core/config/constants.js";
import { buildExtractionGraph, startRun } from "../../../src/graph/index.js";
import { gutterSession } from "../../../src/io/gutter/session.js";
import { FixtureModelProvider } from "../../../src/io/model/fixture-provider.js";
import { loadFixtures } from "../../../src/io/model/fixture-store.js";
import { mirrorPorts } from "../../../src/io/mirror/seeded-mirror.js";
import { applyOperations, approvedOperations } from "../../../src/io/mirror/apply-operations.js";
import type { Signpost } from "../../../src/core/signpost/schema.js";
import type { NodeName } from "../../../src/core/model/types.js";
import type { CommitInput, GraphPorts } from "../../../src/graph/index.js";

const EVAL_REPO =
  process.env["SIGNPOSTS_EVAL"] ?? path.join(process.cwd(), "..", "signposts-eval");
const SCENARIOS = path.join(EVAL_REPO, "scenarios");
const FIXTURES = path.join(EVAL_REPO, "fixtures");

const MODELS: Record<NodeName, string> = {
  extract: MODEL_EXTRACT,
  critic: MODEL_DEFAULT,
  classify: MODEL_CLASSIFY,
  resolve: MODEL_DEFAULT,
};

// The same clock and author the recorder ran under. Any difference changes a
// user turn and misses every fixture.
const NOW = new Date("2026-08-31T00:00:00.000Z");
const AUTHOR = "eval@signposts.local";

interface Step {
  transcript: string;
  expect_operations?: string[];
  expect_mirror_size?: number;
}

interface Scenario {
  name: string;
  dir: string;
  repo: string;
  steps: Step[];
}

function scenarios(): Scenario[] {
  if (!existsSync(SCENARIOS)) {
    return [];
  }
  return readdirSync(SCENARIOS)
    .filter((name) => statSync(path.join(SCENARIOS, name)).isDirectory())
    .sort()
    .map((name) => {
      const spec = parseYaml(
        readFileSync(path.join(SCENARIOS, name, "scenario.yaml"), "utf8"),
      ) as { repo: string; steps: Step[] };
      return { name, dir: path.join(SCENARIOS, name), repo: spec.repo, steps: spec.steps };
    });
}

function portsFor(repo: string, mirror: readonly Signpost[], applied: CommitInput[]): GraphPorts {
  return {
    model: new FixtureModelProvider(loadFixtures(FIXTURES), MODELS),
    gutter: { gutter: (p) => gutterSession(p, { repo, repoRoot: EVAL_REPO }) },
    ...mirrorPorts(mirror),
    commit: { async apply(input) { applied.push(input); } },
    author: AUTHOR,
    now: () => NOW,
  };
}

const cases = scenarios();
const ready = cases.length > 0 && Object.keys(loadFixtures(FIXTURES)).length > 0;

describe.skipIf(!ready)("scenario replay", () => {
  it.each(cases)("$name replays as a sequence", async ({ dir, repo, steps }) => {
    // Starts empty. Every later step sees exactly what the earlier ones built.
    let mirror: Signpost[] = [];

    for (const step of steps) {
      const transcript = path.join(dir, step.transcript);
      const applied: CommitInput[] = [];
      const ports = portsFor(repo, mirror, applied);
      const checkpointer = new MemorySaver();
      const graph = buildExtractionGraph({ ports, checkpointer });
      const session = await gutterSession(transcript, { repo, repoRoot: EVAL_REPO });

      const result = await startRun(graph, checkpointer, {
        repo,
        sessionId: session.sessionId,
        contentHash: session.contentHash,
        repoRoot: EVAL_REPO,
        transcriptPath: transcript,
      });

      const operations = approvedOperations(result.state.gated ?? { auto: [], needsHuman: [] });
      mirror = applyOperations(mirror, operations, NOW);

      const produced = operations.map((operation) => operation.op).sort();
      expect(produced, `${step.transcript} operations`).toEqual(
        [...(step.expect_operations ?? [])].sort(),
      );
      if (step.expect_mirror_size !== undefined) {
        expect(mirror.length, `${step.transcript} mirror size`).toBe(step.expect_mirror_size);
      }
    }
  });
});
