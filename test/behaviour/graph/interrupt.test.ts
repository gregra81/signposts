// The long-lived interrupt, and the durability that makes it work.
//
// This is the property that makes the checkpointer non-optional. A halt may
// be answered later, in a different process — so the test resumes through a
// SECOND graph built on fresh ports, holding nothing from the first run except
// the three values that are on disk anyway (repo, session id, content hash).
// The thread id is recomputed from those, never remembered.
//
// The halt is a model call. It was a person's review until that moved into
// the pull request (19-value-to-a-user.md, "Fewer human steps"), and the
// review-only cases went with it: rejecting, editing, answering in instalments.

import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildExtractionGraph,
  hostModel,
  resumeRun,
  startRun,
} from "../../../src/graph/index.js";
import { buildThreadId } from "../../../src/core/graph/thread-id.js";
import type { RunResult } from "../../../src/graph/index.js";
import {
  CHECKPOINT_FILENAME,
  STATE_VERSION,
  THREAD_EXPIRY_DAYS,
} from "../../../src/core/config/constants.js";
import {
  candidate,
  existingSignpost,
  gutteredSession,
  makeHarness,
  RUN_INPUT,
  scriptedReplies,
  type HarnessOptions,
} from "../helpers/graph-harness.js";

// The real SQLite checkpointer, not MemorySaver: an interrupt that only
// survives inside one process is not the thing 04-extraction-graph.md
// describes.
let stateDir: string;
let checkpointPath: string;
// Every saver a test opens, closed in afterEach. Each one is a live
// better-sqlite3 connection, and this file builds two or three per test — left
// open they accumulate for the whole file, which Stryker then re-runs once per
// mutant batch.
let savers: SqliteSaver[];

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "signposts-graph-"));
  checkpointPath = path.join(stateDir, CHECKPOINT_FILENAME);
  savers = [];
});

afterEach(() => {
  for (const saver of savers) {
    saver.db.close();
  }
  rmSync(stateDir, { recursive: true, force: true });
});

/** Opens a checkpointer on the test's database and registers it for cleanup. */
function openSaver(): SqliteSaver {
  const saver = SqliteSaver.fromConnString(checkpointPath);
  savers.push(saver);
  return saver;
}

const EXISTING = existingSignpost();

/** A run whose operation the gate flags: a supersede always is. */
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

/**
 * A separate process would build all of this from scratch. So does this.
 *
 * `halts`: the graph asks the session for each model call, so the run stops at
 * every one — `ports.model` is then only the script the test answers from.
 * Without it the script answers in-process and the run goes straight through.
 */
function freshProcess(options: HarnessOptions, halts = false) {
  const ports = makeHarness(options);
  const checkpointer = openSaver();
  const graph = buildExtractionGraph({ ports: halts ? { ...ports, model: hostModel } : ports, checkpointer });
  return { ports, checkpointer, graph };
}

const PARTS = { repo: RUN_INPUT.repo, sessionId: RUN_INPUT.sessionId, contentHash: RUN_INPUT.contentHash };

/** The node the run is halted on, asserted to be exactly one. */
function haltedOn(result: RunResult): string {
  expect(result.pending).toHaveLength(1);
  return result.pending[0]!.request.node;
}

describe("the long-lived interrupt", () => {
  it("halts on a model call without committing", async () => {
    const first = freshProcess(gatedOptions(), true);

    const result = await startRun(first.graph, first.checkpointer, RUN_INPUT);

    expect(haltedOn(result)).toBe("extract");
    expect(first.ports.commit.applied).toEqual([]);
  });

  it("resumes in a different process and commits what the gate flagged", async () => {
    const first = freshProcess(gatedOptions(), true);
    let result = await startRun(first.graph, first.checkpointer, RUN_INPUT);

    // Nothing from `first` survives except the checkpoint file.
    const second = freshProcess(gatedOptions(), true);
    while (result.pending.length > 0) {
      result = await resumeRun(second.graph, second.checkpointer, PARTS, await scriptedReplies(second.ports.model, result.pending));
    }

    expect(second.ports.commit.applied).toHaveLength(1);
    expect(second.ports.commit.operations.map((operation) => operation.op)).toContain("supersede");
    expect(second.ports.commit.applied[0]?.flagged.length).toBeGreaterThan(0);
  });

  it("does not ask again what was answered before the gap", async () => {
    const first = freshProcess(gatedOptions(), true);
    const halted = await startRun(first.graph, first.checkpointer, RUN_INPUT);

    const second = freshProcess(gatedOptions(), true);
    const next = await resumeRun(second.graph, second.checkpointer, PARTS, await scriptedReplies(second.ports.model, halted.pending));

    expect(haltedOn(next)).toBe("critic");
    expect(second.ports.model.callsTo("extract")).toHaveLength(1);
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

// 15-spec.md pairs this with the version rule: "A thread older than the
// expiry is dropped with a log line." A halt nobody answered for a month was
// built against a repo that has moved on.
describe("a thread past the expiry", () => {
  /** Backdates the thread's checkpoint by `days`, as a month of silence would. */
  async function backdate(days: number): Promise<void> {
    const saver = openSaver();
    const config = { configurable: { thread_id: buildThreadId(RUN_INPUT) } };
    const tuple = await saver.getTuple(config);
    expect(tuple).toBeDefined();
    await saver.put(
      tuple!.config,
      {
        ...tuple!.checkpoint,
        ts: new Date(Date.now() - days * 86_400_000).toISOString(),
      },
      tuple!.metadata ?? { source: "update", step: -1, parents: {} },
    );
  }

  it("drops the checkpoint, logs why, and extracts again", async () => {
    const stale = freshProcess(gatedOptions());
    await startRun(stale.graph, stale.checkpointer, RUN_INPUT);
    await backdate(THREAD_EXPIRY_DAYS + 1);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const next = freshProcess(gatedOptions());
    const result = await startRun(next.graph, next.checkpointer, RUN_INPUT);

    expect(result.disposition).toBe("discarded");
    expect(next.ports.model.callsTo("extract")).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      `Checkpointed run for thread ${buildThreadId(RUN_INPUT)} is ` +
        `${String(THREAD_EXPIRY_DAYS + 1)} days old (expiry ${String(THREAD_EXPIRY_DAYS)} days). ` +
        "Dropping it and extracting again.",
    );
    warn.mockRestore();
  });

  it("refuses to answer a halt on an expired thread", async () => {
    const stale = freshProcess(gatedOptions(), true);
    const halted = await startRun(stale.graph, stale.checkpointer, RUN_INPUT);
    await backdate(THREAD_EXPIRY_DAYS + 1);

    const next = freshProcess(gatedOptions(), true);
    await expect(
      resumeRun(next.graph, next.checkpointer, PARTS, await scriptedReplies(next.ports.model, halted.pending)),
    ).rejects.toThrow(
      `resumeRun: thread ${buildThreadId(RUN_INPUT)} expired ` +
        `(${String(THREAD_EXPIRY_DAYS + 1)} days old, expiry ${String(THREAD_EXPIRY_DAYS)} days). ` +
        "Re-run the extraction.",
    );

    expect(next.ports.commit.applied).toEqual([]);
  });

  it("still resumes a thread inside the expiry", async () => {
    const stale = freshProcess(gatedOptions());
    await startRun(stale.graph, stale.checkpointer, RUN_INPUT);
    await backdate(THREAD_EXPIRY_DAYS - 1);

    const next = freshProcess(gatedOptions());
    const result = await startRun(next.graph, next.checkpointer, RUN_INPUT);

    expect(result.disposition).toBe("resumed");
    expect(next.ports.model.callsTo("extract")).toHaveLength(0);
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
    const saver = openSaver();
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

  // The path the version check exists for: a resume days later, from another
  // process, after an upgrade. `startRun` guarded it; this did not.
  it("refuses to answer a halt on a thread it cannot resume", async () => {
    const stale = freshProcess(gatedOptions(), true);
    const halted = await startRun(stale.graph, stale.checkpointer, RUN_INPUT);

    const threadId = buildThreadId(RUN_INPUT);
    const saver = openSaver();
    const config = { configurable: { thread_id: threadId } };
    const tuple = await saver.getTuple(config);
    await saver.put(
      tuple!.config,
      {
        ...tuple!.checkpoint,
        channel_values: { ...tuple!.checkpoint.channel_values, version: STATE_VERSION + 1 },
      },
      tuple!.metadata ?? { source: "update", step: -1, parents: {} },
    );

    const next = freshProcess(gatedOptions(), true);
    await expect(
      resumeRun(next.graph, next.checkpointer, PARTS, await scriptedReplies(next.ports.model, halted.pending)),
    ).rejects.toThrow(
      `resumeRun: thread ${threadId} cannot be resumed by this build ` +
        `(state version ${String(STATE_VERSION)}, checkpoint ${String(STATE_VERSION + 1)}). ` +
        "Re-run the extraction.",
    );

    expect(next.ports.commit.applied).toEqual([]);
  });

  // Nothing checkpointed at all — a resume for a thread that was never
  // started, or whose checkpoint file has been cleared out from under it.
  it("refuses a resume when there is no checkpoint to answer", async () => {
    const only = freshProcess(gatedOptions());

    await expect(
      resumeRun(
        only.graph,
        only.checkpointer,
        { repo: RUN_INPUT.repo, sessionId: RUN_INPUT.sessionId, contentHash: RUN_INPUT.contentHash },
        {},
      ),
    ).rejects.toThrow(
      `resumeRun: thread ${buildThreadId(RUN_INPUT)} cannot be resumed by this build ` +
        `(state version ${String(STATE_VERSION)}, checkpoint absent). ` +
        "Re-run the extraction.",
    );

    expect(only.ports.commit.applied).toEqual([]);
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
