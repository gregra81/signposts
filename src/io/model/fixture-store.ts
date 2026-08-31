// The on-disk half of record/replay (09-evaluation.md, "Fixture replay"):
//
//     signposts-eval/fixtures/<hash-of-node-model-prompt-input>.json
//
// One file per model call, named by a hash of everything that could change
// the answer. The model id is in the hash deliberately — switching models
// must miss and force a re-record, never replay another model's answers
// under the new model's name.
//
// Each file also stores the four inputs in full, not just their hash. That
// is what lets `loadFixtures` rebuild FixtureModelProvider's in-memory keys
// without re-deriving them, and it makes a fixture readable when a replay
// miss sends you looking for the near-match that should have hit.
//
// This store lives in the private eval repo, never in signposts: a recorded
// `extract` response is distilled transcript content, and leaks exactly the
// way the transcripts do (09-evaluation.md, "What is public").

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { JSON_INDENT } from "../../core/config/constants.ts";
import { fixtureKey, type FixtureEntry } from "./fixture-provider.ts";
import type { NodeName } from "../../core/model/types.ts";

const FIXTURE_EXTENSION = ".json";

/** The four inputs that identify a call, plus what came back. */
export interface FixtureRecord extends FixtureEntry {
  node: NodeName;
  model: string;
  system: string;
  user: string;
}

/** The filename stem: sha256 over the same tuple `fixtureKey` joins. */
export function fixtureHash(node: NodeName, model: string, system: string, user: string): string {
  return createHash("sha256").update(fixtureKey(node, model, system, user)).digest("hex");
}

/** Writes one fixture, creating `dir` if needed. Overwrites a re-record in place. */
export function writeFixture(dir: string, record: FixtureRecord): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(
    dir,
    `${fixtureHash(record.node, record.model, record.system, record.user)}${FIXTURE_EXTENSION}`,
  );
  writeFileSync(file, `${JSON.stringify(record, null, JSON_INDENT)}\n`);
  return file;
}

/**
 * Every fixture in `dir`, keyed for FixtureModelProvider.
 *
 * A missing directory reads as an empty store rather than throwing: the
 * suite decides whether zero fixtures is a skip or a failure, and it needs
 * to be able to ask.
 */
export function loadFixtures(dir: string): Record<string, FixtureEntry> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return {};
  }

  const fixtures: Record<string, FixtureEntry> = {};
  for (const name of names) {
    if (!name.endsWith(FIXTURE_EXTENSION)) {
      continue;
    }
    const record = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as FixtureRecord;
    fixtures[fixtureKey(record.node, record.model, record.system, record.user)] = {
      value: record.value,
      usage: record.usage,
    };
  }
  return fixtures;
}
