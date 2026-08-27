// The long-lived interrupt, and the durability that makes it work.
//
// This is the property that makes the checkpointer non-optional. A person may
// answer three days later, in a different process — so the test resumes
// through a SECOND graph built on fresh ports, holding nothing from the first
// run except the three values that are on disk anyway (repo, session id,
// content hash). The thread id is recomputed from those, never remembered.

import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildExtractionGraph, resumeRun, startRun } from "../../../src/graph/index.js";
import { buildThreadId } from "../../../src/core/graph/thread-id.js";
import { operationKey } from "../../../src/core/graph/decisions.js";
import { CHECKPOINT_FILENAME, STATE_VERSION } from "../../../src/core/config/constants.js";
import {
  candidate,
  existingSignpost,
  gutteredSession,
  makeHarness,
  RUN_INPUT,
  type HarnessOptions,
} from "./harness.js";

// The real SQLite checkpointer, not MemorySaver: an interrupt that only
// survives inside one process is not the thing 04-extraction-graph.md
// describes.
let stateDir: string;
let checkpointPath: string;

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "signposts-graph-"));
  checkpointPath = path.join(stateDir, CHECKPOINT_FILENAME);
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

const EXISTING = existingSignpost();

/** A run that will stop for a human: a retire always needs one. */
function gatedOptions(): HarnessOptions {
  return {
    session: gutteredSession(),
    existing: [EXISTING],
    neighbours: { t1: [EXISTING] },
    script: {
      extract: [{ candidates: [candidate({ confidence: 1 })] }],
      critic: [{ verdicts: [{ tempId: "t1", keep: true, reason: "durable" }] }],
      classify: [
        { tempId: "t1", kind: "CONTRADICTION", relatedId: EXISTING.id, rationale: "opposite" },
      ],
      resolve: [{ tempId: "t1", outcome: "new_wins", reasoning: "the config changed in March" }],
    },
  };
}

/** A separate process would build all of this from scratch. So does this. */
function freshProcess(options: HarnessOptions) {
  const ports = makeHarness(options);
  const checkpointer = SqliteSaver.fromConnString(checkpointPath);
  return { ports, checkpointer, graph: buildExtractionGraph({ ports, checkpointer }) };
}

describe("the long-lived interrupt", () => {
  it("halts without committing when the gate needs a human", async () => {
    const first = freshProcess(gatedOptions());

    const result = await startRun(first.graph, first.checkpointer, RUN_INPUT);

    expect(result.state.gated.needsHuman).toHaveLength(1);
    expect(first.ports.commit.applied).toEqual([]);
  });

  it("resumes in a different process and commits the accepted operation", async () => {
    const first = freshProcess(gatedOptions());
    const halted = await startRun(first.graph, first.checkpointer, RUN_INPUT);
    const [pending] = halted.state.gated.needsHuman;
    expect(pending).toBeDefined();

    // Three days pass. Nothing from `first` survives except the checkpoint file.
    const second = freshProcess(gatedOptions());
    await resumeRun(
      second.graph,
      { repo: RUN_INPUT.repo, sessionId: RUN_INPUT.sessionId, contentHash: RUN_INPUT.contentHash },
      { [operationKey(pending!.operation)]: { decision: "accept", decidedAt: "2026-08-30" } },
    );

    expect(second.ports.commit.applied).toHaveLength(1);
    expect(second.ports.commit.operations).toEqual([pending!.operation]);
  });

  it("does not re-run extraction on resume", async () => {
    const first = freshProcess(gatedOptions());
    const halted = await startRun(first.graph, first.checkpointer, RUN_INPUT);
    const [pending] = halted.state.gated.needsHuman;

    const second = freshProcess(gatedOptions());
    await resumeRun(
      second.graph,
      { repo: RUN_INPUT.repo, sessionId: RUN_INPUT.sessionId, contentHash: RUN_INPUT.contentHash },
      { [operationKey(pending!.operation)]: { decision: "accept", decidedAt: "2026-08-30" } },
    );

    expect(second.ports.model.callsTo("extract")).toEqual([]);
    expect(second.ports.model.calls).toEqual([]);
  });

  it("commits nothing when the human rejects", async () => {
    const first = freshProcess(gatedOptions());
    const halted = await startRun(first.graph, first.checkpointer, RUN_INPUT);
    const [pending] = halted.state.gated.needsHuman;

    const second = freshProcess(gatedOptions());
    await resumeRun(
      second.graph,
      { repo: RUN_INPUT.repo, sessionId: RUN_INPUT.sessionId, contentHash: RUN_INPUT.contentHash },
      { [operationKey(pending!.operation)]: { decision: "reject", decidedAt: "2026-08-30" } },
    );

    expect(second.ports.commit.operations).toEqual([]);
  });

  it("commits the human's replacement when they edit", async () => {
    const first = freshProcess(gatedOptions());
    const halted = await startRun(first.graph, first.checkpointer, RUN_INPUT);
    const [pending] = halted.state.gated.needsHuman;
    const edited = { op: "retire", id: EXISTING.id, reason: "superseded by hand" } as const;

    const second = freshProcess(gatedOptions());
    await resumeRun(
      second.graph,
      { repo: RUN_INPUT.repo, sessionId: RUN_INPUT.sessionId, contentHash: RUN_INPUT.contentHash },
      { [operationKey(pending!.operation)]: { decision: "edit", edited, decidedAt: "2026-08-30" } },
    );

    expect(second.ports.commit.operations).toEqual([edited]);
  });
});

describe("thread identity", () => {
  it("re-running an unchanged session lands on the same thread and re-extracts nothing", async () => {
    const first = freshProcess({
      session: gutteredSession(),
      script: {
        extract: [{ candidates: [candidate()] }],
        critic: [{ verdicts: [{ tempId: "t1", keep: true, reason: "r" }] }],
        classify: [{ tempId: "t1", kind: "NOVEL", rationale: "r" }],
      },
    });
    const done = await startRun(first.graph, first.checkpointer, RUN_INPUT);
    expect(done.disposition).toBe("fresh");

    const second = freshProcess({
      session: gutteredSession(),
      script: {
        extract: [{ candidates: [candidate()] }],
        critic: [{ verdicts: [{ tempId: "t1", keep: true, reason: "r" }] }],
        classify: [{ tempId: "t1", kind: "NOVEL", rationale: "r" }],
      },
    });
    const again = await startRun(second.graph, second.checkpointer, RUN_INPUT);

    expect(again.disposition).toBe("resumed");
    expect(second.ports.model.calls).toEqual([]);
    expect(second.ports.commit.applied).toEqual([]);
  });

  // contentHash is part of the thread id, so an edited transcript is a
  // different thread — a resume can never gutter different bytes than the run
  // that was interrupted.
  it("treats a transcript that changed since the interrupt as a different thread", async () => {
    const first = freshProcess(gatedOptions());
    await startRun(first.graph, first.checkpointer, RUN_INPUT);

    const second = freshProcess({
      ...gatedOptions(),
      session: gutteredSession({ contentHash: "hash-2" }),
    });
    const changed = await startRun(second.graph, second.checkpointer, {
      ...RUN_INPUT,
      contentHash: "hash-2",
    });

    expect(changed.threadId).not.toBe(buildThreadId(RUN_INPUT));
    expect(changed.disposition).toBe("fresh");
    expect(second.ports.model.callsTo("extract")).toHaveLength(1);
  });
});

describe("an unrecognised state version", () => {
  // The rule: discard and re-run from the transcript. Never resume into a
  // shape this build no longer understands.
  it("discards the checkpoint and starts the run again", async () => {
    const stale = freshProcess(gatedOptions());
    await startRun(stale.graph, stale.checkpointer, RUN_INPUT);

    // Rewrite the checkpointed version to something this build does not know,
    // exactly as a build from a later state shape would have left it.
    const threadId = buildThreadId(RUN_INPUT);
    const saver = SqliteSaver.fromConnString(checkpointPath);
    const config = { configurable: { thread_id: threadId } };
    const tuple = await saver.getTuple(config);
    expect(tuple).toBeDefined();
    await saver.put(
      tuple!.config,
      {
        ...tuple!.checkpoint,
        channel_values: { ...tuple!.checkpoint.channel_values, version: STATE_VERSION + 1 },
      },
      tuple!.metadata ?? { source: "update", step: -1, parents: {} },
    );

    const next = freshProcess(gatedOptions());
    const result = await startRun(next.graph, next.checkpointer, RUN_INPUT);

    expect(result.disposition).toBe("discarded");
    // Re-run from the transcript: the transcript was read again and the model
    // was asked again, rather than the halted state being resumed.
    expect(next.ports.gutter.calls).toBeGreaterThan(0);
    expect(next.ports.model.callsTo("extract")).toHaveLength(1);
  });

  it("resumes normally when the version is the one this build writes", async () => {
    const first = freshProcess(gatedOptions());
    await startRun(first.graph, first.checkpointer, RUN_INPUT);

    const second = freshProcess(gatedOptions());
    const result = await startRun(second.graph, second.checkpointer, RUN_INPUT);

    expect(result.disposition).toBe("resumed");
    expect(result.state.version).toBe(STATE_VERSION);
  });
});
