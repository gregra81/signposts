// The session watermark: how the SessionStart hook learns that a transcript
// has been judged (07-triggering-and-ux.md, "Wake on something").
//
// The hook cannot open a database inside HOOK_BUDGET_MS, so it approximates
// eligibility from mtimes and subtracts `lastRunFinishedAt` — everything at or
// before that has been dealt with. Nothing wrote that field, so the watermark
// was always 0 and the hook announced the same backlog at every session start
// for as long as the transcripts sat there. `settle` writes it now, and this
// file drives the CLI and then reads the result through the hook's own
// functions, because the two halves shipping separately is exactly how the
// field came to have a reader and no writer.

import { MemorySaver } from "@langchain/langgraph";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig, type ResolvedConfig } from "../../../src/core/config/resolve.js";
import type { WorkerStatus } from "../../../src/core/worker/status.js";
import { buildExtractionGraph } from "../../../src/graph/index.js";
import type { FinishedSession, OpenRun, RunHandle, RunSession } from "../../../src/cli/run-port.js";
import { looksEligible, watermarkMs } from "../../../hooks/session-start.ts";
import { createFakeStdio } from "../helpers/fake-stdio.js";
import { runCli } from "../helpers/run-cli.js";
import {
  candidate,
  existingSignpost,
  gutteredSession,
  makeHarness,
  RUN_INPUT,
  type HarnessOptions,
  type Script,
} from "../helpers/graph-harness.js";

const LAST_ACTIVITY = new Date("2026-09-01T09:00:00Z");

const SESSION: RunSession = {
  sessionId: RUN_INPUT.sessionId,
  contentHash: RUN_INPUT.contentHash,
  transcriptPath: RUN_INPUT.transcriptPath,
  lastActivityAt: LAST_ACTIVITY,
};

/** An older transcript nobody has run yet — the case a wall-clock stamp buries. */
const UNTOUCHED: RunSession = {
  sessionId: "older-session",
  contentHash: "hash-older",
  transcriptPath: "/tmp/older.jsonl",
  lastActivityAt: new Date("2026-08-30T09:00:00Z"),
};

/** One clear correction, nothing like it recorded: the gate publishes it. */
const AUTO: Script = {
  extract: [{ candidates: [candidate()] }],
  critic: [{ verdicts: [{ tempId: "t1", keep: true, reason: "durable" }] }],
  classify: [{ tempId: "t1", kind: "NOVEL", rationale: "nothing like it" }],
};

const EXISTING = existingSignpost();

/** The same correction against a claim it contradicts: the run halts on a person. */
function gated(): HarnessOptions {
  return {
    session: gutteredSession(),
    existing: [EXISTING],
    neighbours: { t1: [EXISTING] },
    script: {
      ...AUTO,
      classify: [{ tempId: "t1", kind: "CONTRADICTION", relatedId: EXISTING.id, rationale: "opposite" }],
      resolve: [{ tempId: "t1", outcome: "new_wins", reasoning: "the config changed in March" }],
    },
  };
}

describe("the watermark a finished run leaves for the hook", () => {
  let repoRoot: string;
  let config: ResolvedConfig;

  /**
   * A run seam whose `eligible` answers the way the real one does: the session
   * disappears from it once `finish` has recorded it, so `settle` can tell a
   * drained backlog from one it has only made a dent in.
   */
  function seam(options: HarnessOptions, alsoWaiting: RunSession[] = []): OpenRun {
    const ports = makeHarness(options);
    const checkpointer = new MemorySaver();
    const finished: FinishedSession[] = [];
    const handle: RunHandle = {
      repo: RUN_INPUT.repo,
      graph: buildExtractionGraph({ ports, checkpointer }),
      checkpointer,
      pendingIndex: ports.pendingIndex,
      index: ports.index,
      eligible: () =>
        [SESSION, ...alsoWaiting].filter(
          (session) => !finished.some((done) => done.sessionId === session.sessionId),
        ),
      finish: (session) => finished.push(session),
      prNotOpened: () => null,
      pendingReviews: () => Promise.resolve([]),
      close: () => {},
    };
    return () => Promise.resolve({ handle });
  }

  function status(): WorkerStatus | undefined {
    try {
      return JSON.parse(readFileSync(config.paths.statuslineState, "utf8")) as WorkerStatus;
    } catch {
      return undefined;
    }
  }

  beforeEach(() => {
    repoRoot = mkdtempSync(path.join(tmpdir(), "signposts-watermark-"));
    config = resolveConfig({
      repoRoot,
      homeDir: repoRoot,
      repoFileContents: undefined,
      userFileContents: undefined,
      env: {},
    });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("records the finished session's own last activity, not the wall clock", async () => {
    await runCli(["run"], {
      config,
      openRun: seam({ script: AUTO, session: gutteredSession() }),
      stdio: createFakeStdio(),
    });

    // The clock would silence every transcript that fell quiet just before the
    // run — including the session the developer was sitting in while it went.
    expect(status()?.lastRunFinishedAt).toBe(LAST_ACTIVITY.toISOString());
  });

  it("stops the hook counting the transcript it just judged", async () => {
    await runCli(["run"], {
      config,
      openRun: seam({ script: AUTO, session: gutteredSession() }),
      stdio: createFakeStdio(),
    });

    // Well past IDLE_HOURS and well inside MAX_AGE_DAYS: eligible on mtimes
    // alone, so the watermark is the only thing that can rule it out.
    const nowMs = LAST_ACTIVITY.getTime() + 24 * 60 * 60 * 1000;
    const transcript = { lastActivityMs: LAST_ACTIVITY.getTime(), startedMs: LAST_ACTIVITY.getTime() };

    expect(looksEligible(transcript, nowMs, 0)).toBe(true);
    expect(looksEligible(transcript, nowMs, watermarkMs(status() ?? {}))).toBe(false);
  });

  it("leaves the watermark alone while the session is still halted on a review", async () => {
    await runCli(["run"], { config, openRun: seam(gated()), stdio: createFakeStdio() });

    // Nothing has been judged yet: the developer has not answered.
    expect(status()?.lastRunFinishedAt).toBeUndefined();
  });

  it("waits for the backlog to drain, so an older transcript is not buried with it", async () => {
    await runCli(["run"], {
      config,
      openRun: seam({ script: AUTO, session: gutteredSession() }, [UNTOUCHED]),
      stdio: createFakeStdio(),
    });

    // One date for the whole repo: stamping it here would silence the hook
    // about `UNTOUCHED` permanently, and nobody has looked at that transcript.
    expect(status()?.lastRunFinishedAt).toBeUndefined();
  });

  it("keeps the census the worker wrote in the same file", async () => {
    mkdirSync(path.dirname(config.paths.statuslineState), { recursive: true });
    writeFileSync(
      config.paths.statuslineState,
      JSON.stringify({ phase: "idle", updatedAt: "2026-09-01T08:00:00.000Z", eligibleSessions: 1, threadsWaiting: 3 }),
    );

    await runCli(["run"], {
      config,
      openRun: seam({ script: AUTO, session: gutteredSession() }),
      stdio: createFakeStdio(),
    });

    // Two processes, one file. `threadsWaiting` is what the hook's review
    // notice is built from, and only the worker can count it.
    expect(status()).toMatchObject({ threadsWaiting: 3, lastRunFinishedAt: LAST_ACTIVITY.toISOString() });
  });
});
