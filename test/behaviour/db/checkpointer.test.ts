// Behaviour test for openCheckpointer — outside test/unit for the same
// reason as migrate.test.ts: the mutation-graded unit suite excludes
// src/io/.
//
// What a killed process actually needs from this module is covered in
// test/behaviour/graph/process-death.test.ts. This file covers the two
// things that happen before a graph is ever built: the file is created and
// reopened, and a file that is not a database says so at the call that
// opened it.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCheckpointer } from "../../../src/io/db/checkpointer.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "signposts-checkpointer-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const CONFIG = { configurable: { thread_id: "thread-1" } };

function checkpoint(value: string) {
  return {
    v: 4,
    id: "checkpoint-1",
    ts: "2026-08-31T09:00:00.000Z",
    channel_values: { claim: value },
    channel_versions: {},
    versions_seen: {},
  };
}

describe("openCheckpointer", () => {
  it("creates the state directory and hands the next handle what the last one wrote", async () => {
    // Nested under a directory that does not exist yet: the first run on a
    // machine has no ~/.signposts/<repo-hash>/.
    const checkpointPath = path.join(dir, "state", "checkpoints.db");

    const first = openCheckpointer(checkpointPath);
    await first.checkpointer.put(
      CONFIG,
      checkpoint("staging is read only"),
      { source: "update", step: -1, parents: {} },
      {},
    );
    first.close();

    const second = openCheckpointer(checkpointPath);
    const tuple = await second.checkpointer.getTuple(CONFIG);
    second.close();

    expect(tuple?.checkpoint.channel_values).toEqual({ claim: "staging is read only" });
  });

  it("has nothing for a thread it has never seen", async () => {
    const handle = openCheckpointer(path.join(dir, "checkpoints.db"));
    const tuple = await handle.checkpointer.getTuple(CONFIG);
    handle.close();

    expect(tuple).toBeUndefined();
  });

  // Without the pragma read this returns a handle and fails later, from
  // inside startRun, with the connection still open.
  it("fails at open when the file is not a database", () => {
    const checkpointPath = path.join(dir, "checkpoints.db");
    writeFileSync(checkpointPath, "this is not a SQLite file");

    expect(() => openCheckpointer(checkpointPath)).toThrow(/not a database/);
  });
});
