// The regression suite the recording run exists to make possible.
//
// Runs the real graph over the real golden transcripts with
// FixtureModelProvider, so every LLM node returns a response a model actually
// produced — offline, at no cost, byte-identically on every run
// (09-evaluation.md, "Fixture replay").
//
// No network is reachable from here by construction, not by assertion:
// FixtureModelProvider never imports the SDK, and a key it has no fixture for
// throws rather than falling through to a live call. A prompt that changed
// since recording therefore fails this suite loudly, which is the point — it
// is the same signal as a snapshot test, with the model in the snapshot.
//
// Both repos are needed and only one of them is public, so the whole suite
// skips when the eval checkout is absent (CI, a fresh clone, anyone who is
// not Greg). Skipping is honest here: the fixtures are private data, and a
// suite that failed without them would be failing on a missing secret rather
// than on a defect.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import {
  MODEL_CLASSIFY,
  MODEL_DEFAULT,
  MODEL_EXTRACT,
} from "../../../src/core/config/constants.js";
import { buildExtractionGraph, startRun } from "../../../src/graph/index.js";
import { gutterSession } from "../../../src/io/gutter/session.js";
import { FixtureModelProvider } from "../../../src/io/model/fixture-provider.js";
import { seededMirror, type MirrorSeed } from "../../../src/io/mirror/seeded-mirror.js";
import { loadFixtures } from "../../../src/io/model/fixture-store.js";
import type { NodeName } from "../../../src/core/model/types.js";
import type { CommitInput, GraphPorts } from "../../../src/graph/index.js";

const EVAL_REPO =
  process.env["SIGNPOSTS_EVAL"] ?? path.join(process.cwd(), "..", "signposts-eval");
const GOLDEN = path.join(EVAL_REPO, "golden");
const FIXTURES = path.join(EVAL_REPO, "fixtures");

const MODELS: Record<NodeName, string> = {
  extract: MODEL_EXTRACT,
  critic: MODEL_DEFAULT,
  classify: MODEL_CLASSIFY,
  resolve: MODEL_DEFAULT,
};

// The same empty mirror, fixed clock and author the recorder ran under. Any
// difference here would change a user turn and miss every fixture.
const NOW = new Date("2026-08-31T00:00:00.000Z");
const AUTHOR = "eval@signposts.local";

interface GoldenCase {
  name: string;
  transcript: string;
  repo: string;
  /** The mirror this case starts from; empty unless expected.yaml seeds one. */
  mirror: MirrorSeed[];
}

function goldenCases(): GoldenCase[] {
  if (!existsSync(GOLDEN)) {
    return [];
  }
  return readdirSync(GOLDEN)
    .filter((name) => statSync(path.join(GOLDEN, name)).isDirectory())
    .sort()
    .map((name) => {
      const expected = parseYaml(
        readFileSync(path.join(GOLDEN, name, "expected.yaml"), "utf8"),
      ) as { repo: string; mirror?: MirrorSeed[] };
      return {
        name,
        transcript: path.join(GOLDEN, name, "transcript.jsonl"),
        repo: expected.repo,
        mirror: expected.mirror ?? [],
      };
    });
}

function portsFor(
  repo: string,
  repoRoot: string,
  seeds: readonly MirrorSeed[],
  applied: CommitInput[],
): GraphPorts {
  // The same mirror the recorder ran under. A case whose expected.yaml seeds
  // nothing gets an empty one, exactly as before seeding existed.
  const mirror = seededMirror(seeds, AUTHOR);
  return {
    model: new FixtureModelProvider(loadFixtures(FIXTURES), MODELS),
    gutter: { gutter: (transcriptPath) => gutterSession(transcriptPath, { repo, repoRoot }) },
    neighbours: mirror.neighbours,
    index: mirror.index,
    commit: { async apply(input) { applied.push(input); } },
    author: AUTHOR,
    now: () => NOW,
  };
}

const cases = goldenCases();
const fixtureCount = Object.keys(loadFixtures(FIXTURES)).length;
const ready = cases.length > 0 && fixtureCount > 0;

describe.skipIf(!ready)("golden-set replay", () => {
  it.each(cases)("$name replays from fixtures", async ({ transcript, repo, mirror }) => {
    const applied: CommitInput[] = [];
    const ports = portsFor(repo, EVAL_REPO, mirror, applied);
    const checkpointer = new MemorySaver();
    const graph = buildExtractionGraph({ ports, checkpointer });

    const session = await gutterSession(transcript, { repo, repoRoot: EVAL_REPO });

    // A fixture miss throws out of FixtureModelProvider with the node, model
    // and prompt it could not find, so this assertion is the whole test: if
    // it resolves, every model call in this run was served from disk.
    const result = await startRun(graph, checkpointer, {
      repo,
      sessionId: session.sessionId,
      contentHash: session.contentHash,
      repoRoot: EVAL_REPO,
      transcriptPath: transcript,
    });

    expect(result.state.version).toBeDefined();
  });
});
