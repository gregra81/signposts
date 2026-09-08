// `signpost review`: the developer answering, at their own terminal, what a
// run left waiting.
//
// The shape of every test here is the shape of the feature. A run halts and
// the process that started it goes away. Nothing is carried over — no thread
// id, no interrupt id, no list of what was pending — and a later invocation
// finds the halt by reading the checkpoint database, shows it, and resumes it
// with what was typed. Each phase opens its own checkpointer on the same file
// and closes it again, which is what a second process would do.
//
// The graph behind it is the scripted harness rather than a live model: what
// is under test is the review surface, and test/behaviour/graph/interrupt.test.ts
// already proves the halt itself survives a real SIGKILL.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHECKPOINT_FILENAME, THREAD_EXPIRY_DAYS } from "../../../src/core/config/constants.js";
import { resolveConfig, type ResolvedConfig } from "../../../src/core/config/resolve.js";
import { buildThreadId } from "../../../src/core/graph/thread-id.js";
import { buildExtractionGraph, startRun } from "../../../src/graph/index.js";
import { openCheckpointer } from "../../../src/io/db/checkpointer.js";
import { listPendingReviews } from "../../../src/io/review/pending.js";
import type { FinishedSession, OpenRun, RunHandle } from "../../../src/cli/run-port.js";
import {
  candidate,
  existingSignpost,
  gutteredSession,
  makeHarness,
  RUN_INPUT,
  type Harness,
  type HarnessOptions,
} from "../helpers/graph-harness.js";
import { createEofStdio, createScriptedStdio } from "../helpers/fake-stdio.js";
import { runCli } from "../helpers/run-cli.js";

const EXISTING = existingSignpost();

/** A run that will stop for a human: a contradiction resolved against a recorded claim. */
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

let stateDir: string;
let checkpointPath: string;
let config: ResolvedConfig;
/** Sessions the review recorded as processed, so a later run does not redo them. */
let finished: FinishedSession[];

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "signposts-review-"));
  checkpointPath = path.join(stateDir, CHECKPOINT_FILENAME);
  finished = [];
  config = resolveConfig({
    repoRoot: RUN_INPUT.repoRoot,
    homeDir: stateDir,
    repoFileContents: undefined,
    userFileContents: undefined,
    env: {},
  });
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

/**
 * The run that halts, in a process of its own.
 *
 * This is `signpost run` doing what the background worker does: reach the
 * interrupt, stop, and exit. It never shows a prompt — that is the separation
 * the review command exists to keep.
 */
async function haltForReview(): Promise<void> {
  const { checkpointer, close } = openCheckpointer(checkpointPath);
  try {
    const graph = buildExtractionGraph({ ports: makeHarness(gatedOptions()), checkpointer });
    const result = await startRun(graph, checkpointer, RUN_INPUT);
    expect(result.pending).toHaveLength(1);
  } finally {
    close();
  }
}

/**
 * An `openRun` over the same checkpoint file and a fresh set of ports.
 *
 * `pendingReviews` is the production listing (src/io/review/pending.ts), which
 * is the half of this feature that has to work from nothing but the database.
 * `eligible` returns nothing, as it would for a transcript that is not on this
 * machine — the review must not need the transcript to answer a halt.
 */
function openRunWith(harness: Harness): OpenRun {
  return async ({ warn }) => {
    const { checkpointer, close } = openCheckpointer(checkpointPath);
    const graph = buildExtractionGraph({ ports: harness, checkpointer });
    const handle: RunHandle = {
      repo: RUN_INPUT.repo,
      graph,
      checkpointer,
      pendingIndex: harness.pendingIndex,
      index: harness.index,
      eligible: () => [],
      finish: (session) => finished.push(session),
      pendingReviews: (now) =>
        listPendingReviews({ graph, checkpointer, repo: RUN_INPUT.repo, now, warn }),
      close,
    };
    return { handle };
  };
}

describe("signpost review", () => {
  it("lists what is waiting, and how long it has been", async () => {
    await haltForReview();

    const stdio = createScriptedStdio(["q"]);
    const exitCode = await runCli(["review"], {
      config,
      stdio,
      openRun: openRunWith(makeHarness(gatedOptions())),
    });

    expect(exitCode).toBe(0);
    expect(stdio.writtenOutput()).toContain(`1 session waiting for review`);
    expect(stdio.writtenOutput()).toContain(`session ${RUN_INPUT.sessionId} — 1 operation`);
    expect(stdio.writtenOutput()).toMatch(/waiting 0 hours/);
  });

  it("shows the claim before and after, and why it stopped", async () => {
    await haltForReview();

    const stdio = createScriptedStdio(["q"]);
    await runCli(["review"], { config, stdio, openRun: openRunWith(makeHarness(gatedOptions())) });

    const out = stdio.writtenOutput();
    expect(out).toContain(`supersede ${EXISTING.id} — it changes a signpost you already have`);
    expect(out).toContain(`- ${EXISTING.claim}`);
    expect(out).toContain(`+ ${candidate().claim}`);
    expect(out).toContain("[a]ccept [r]eject [e]dit [s]kip [q]uit");
  });

  it("commits what the developer accepts, and records the session as done", async () => {
    await haltForReview();
    const harness = makeHarness(gatedOptions());

    const stdio = createScriptedStdio(["a"]);
    const exitCode = await runCli(["review"], { config, stdio, openRun: openRunWith(harness) });

    expect(exitCode).toBe(0);
    expect(harness.commit.operations.map((operation) => operation.op)).toEqual(["supersede"]);
    expect(stdio.writtenOutput()).toContain(`session ${RUN_INPUT.sessionId}: done`);
    // Otherwise the next run extracts a transcript whose signposts are already
    // in the branch.
    expect(finished.map((session) => session.sessionId)).toEqual([RUN_INPUT.sessionId]);
  });

  it("commits nothing when the developer rejects, and does not ask again", async () => {
    await haltForReview();
    const harness = makeHarness(gatedOptions());

    await runCli(["review"], { config, stdio: createScriptedStdio(["r"]), openRun: openRunWith(harness) });

    expect(harness.commit.operations).toEqual([]);
    expect(finished).toHaveLength(1);

    // A rejection is a decision, so the thread is finished rather than halted:
    // a second review finds nothing left.
    const second = createScriptedStdio(["q"]);
    await runCli(["review"], { config, stdio: second, openRun: openRunWith(makeHarness(gatedOptions())) });
    expect(second.writtenOutput()).toContain("Nothing is waiting for review.");
  });

  it("commits the wording the developer typed when they edit", async () => {
    await haltForReview();
    const harness = makeHarness(gatedOptions());
    const reworded = "Staging is writable only inside the nightly ETL window";

    const stdio = createScriptedStdio(["e", reworded, ""]);
    await runCli(["review"], { config, stdio, openRun: openRunWith(harness) });

    const [operation] = harness.commit.operations;
    expect(operation?.op).toBe("supersede");
    expect(operation).toMatchObject({ id: EXISTING.id, replacement: { claim: reworded } });
    // The evidence was left alone by an empty line, not blanked.
    expect(operation).toMatchObject({ replacement: { evidence: candidate().evidence } });
  });

  it("leaves a skipped operation waiting for the next time", async () => {
    await haltForReview();
    const harness = makeHarness(gatedOptions());

    await runCli(["review"], { config, stdio: createScriptedStdio(["s"]), openRun: openRunWith(harness) });

    expect(harness.commit.applied).toEqual([]);
    expect(finished).toEqual([]);

    const second = createScriptedStdio(["a"]);
    const next = makeHarness(gatedOptions());
    await runCli(["review"], { config, stdio: second, openRun: openRunWith(next) });
    expect(next.commit.operations.map((operation) => operation.op)).toEqual(["supersede"]);
  });

  it("re-asks an answer it does not recognise rather than deciding", async () => {
    await haltForReview();
    const harness = makeHarness(gatedOptions());

    const stdio = createScriptedStdio(["yes", "a"]);
    await runCli(["review"], { config, stdio, openRun: openRunWith(harness) });

    expect(stdio.writtenOutput()).toContain("Not one of [a]ccept");
    expect(harness.commit.operations).toHaveLength(1);
  });

  it("refuses to run when stdin is not a terminal", async () => {
    await haltForReview();
    const harness = makeHarness(gatedOptions());

    const stdio = createEofStdio();
    const exitCode = await runCli(["review"], { config, stdio, openRun: openRunWith(harness) });

    expect(exitCode).toBe(1);
    expect(stdio.writtenError()).toContain("answered by a person at a terminal");
    expect(stdio.writtenOutput()).toBe("");
    expect(harness.commit.applied).toEqual([]);
  });

  it("drops a thread nobody answered for a month, and says so", async () => {
    await haltForReview();
    await backdate(THREAD_EXPIRY_DAYS + 1);

    const stdio = createScriptedStdio(["q"]);
    const exitCode = await runCli(["review"], {
      config,
      stdio,
      openRun: openRunWith(makeHarness(gatedOptions())),
    });

    expect(exitCode).toBe(0);
    expect(stdio.writtenError()).toContain(
      `Pending review for thread ${buildThreadId(RUN_INPUT)} is ` +
        `${String(THREAD_EXPIRY_DAYS + 1)} days old (expiry ${String(THREAD_EXPIRY_DAYS)} days). ` +
        "Dropping it.",
    );
    expect(stdio.writtenOutput()).toContain("Nothing is waiting for review.");
  });
});

/** Backdates the thread's checkpoint by `days`, as a month of silence would. */
async function backdate(days: number): Promise<void> {
  const { checkpointer, close } = openCheckpointer(checkpointPath);
  try {
    const threadConfig = { configurable: { thread_id: buildThreadId(RUN_INPUT) } };
    const tuple = await checkpointer.getTuple(threadConfig);
    expect(tuple).toBeDefined();
    await checkpointer.put(
      tuple!.config,
      { ...tuple!.checkpoint, ts: new Date(Date.now() - days * 86_400_000).toISOString() },
      tuple!.metadata ?? { source: "update", step: -1, parents: {} },
      {},
    );
  } finally {
    close();
  }
}
