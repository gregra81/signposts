// The exit codes `run` and `resume` report (12-wire-contracts.md, "Exit
// codes"; 15-spec.md story 77).
//
// Two of the outcomes signposts expects to have are not failures, and a
// caller that reads `$?` — a hook, a CI step, a shell loop — has no way to
// tell that from the generic 1 unless they have codes of their own. This file
// drives the CLI the way that caller does and asserts the number it gets:
// 5 when a person still has to answer, 4 when the extraction is committed to a
// branch that has no pull request, 0 when the run finished with one.
//
// The run seam is a fake here (../helpers/run-cli.ts's `openRun` override) so
// that the graph reaches those three endings on a scripted model rather than
// on real calls. What is real is everything the assertion is about: the CLI,
// the graph, and the exit code that comes back out of it.

import { MemorySaver } from "@langchain/langgraph";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT_CODES } from "../../../src/core/cli/exit-codes.js";
import { resolveConfig, type ResolvedConfig } from "../../../src/core/config/resolve.js";
import { buildExtractionGraph } from "../../../src/graph/index.js";
import type { OpenRun, RunHandle, RunSession } from "../../../src/cli/run-port.js";
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

const SESSION: RunSession = {
  sessionId: RUN_INPUT.sessionId,
  contentHash: RUN_INPUT.contentHash,
  transcriptPath: RUN_INPUT.transcriptPath,
  lastActivityAt: new Date("2026-09-01T09:00:00Z"),
};

/** One clear correction, nothing like it recorded: the gate publishes it. */
const AUTO: Script = {
  extract: [{ candidates: [candidate()] }],
  critic: [{ verdicts: [{ tempId: "t1", keep: true, reason: "durable" }] }],
  classify: [{ tempId: "t1", kind: "NOVEL", rationale: "nothing like it" }],
};

const EXISTING = existingSignpost();

/** The same correction against a claim that contradicts it: a person decides. */
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

describe("what a run reports to whatever ran it", () => {
  let repoRoot: string;
  let config: ResolvedConfig;

  /** How often the seam was asked what is still eligible — see the last test. */
  let eligibleCalls: number;

  /** A run seam over the scripted graph, saying what its commit port left undone. */
  function seam(options: HarnessOptions, prNotOpened: string | null = null): OpenRun {
    const ports = makeHarness(options);
    const checkpointer = new MemorySaver();
    const handle: RunHandle = {
      repo: RUN_INPUT.repo,
      graph: buildExtractionGraph({ ports, checkpointer }),
      checkpointer,
      pendingIndex: ports.pendingIndex,
      index: ports.index,
      eligible: () => {
        eligibleCalls += 1;
        return [SESSION];
      },
      finish: () => {},
      prNotOpened: () => prNotOpened,
      commitOutcome: () => null,
      syncCorpus: () => Promise.resolve({ failures: [] }),
      pendingReviews: () => Promise.resolve([]),
      close: () => {},
    };
    return () => Promise.resolve({ handle });
  }

  beforeEach(() => {
    eligibleCalls = 0;
    repoRoot = mkdtempSync(path.join(tmpdir(), "signposts-exit-"));
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

  it("exits 0 when the session finished and its pull request was opened", async () => {
    const stdio = createFakeStdio();

    const exitCode = await runCli(["run"], { config, openRun: seam({ script: AUTO, session: gutteredSession() }), stdio });

    expect(exitCode).toBe(EXIT_CODES.ok);
    expect(JSON.parse(stdio.writtenOutput())).toMatchObject({ status: "finished" });
  });

  it("exits 4, not 1, when the work is committed and no pull request could be opened", async () => {
    const stdio = createFakeStdio();
    const command = "gh pr create --head signposts/greg/2026-09-05 --title 'signposts: …'";

    const exitCode = await runCli(["run"], {
      config,
      openRun: seam({ script: AUTO, session: gutteredSession() }, command),
      stdio,
    });

    // Not a failure: the session ran to the end, the proposals are on the
    // branch, and what is missing is one command a developer can run. A
    // caller that treats non-zero as fatal is meant to special-case this
    // number rather than report a broken run.
    expect(exitCode).toBe(EXIT_CODES.prCreationFailed);
    expect(exitCode).not.toBe(EXIT_CODES.failure);
    expect(JSON.parse(stdio.writtenOutput())).toMatchObject({ status: "finished" });
  });

  it("exits 5 when the run is halted on a review only a person can answer", async () => {
    const stdio = createFakeStdio();

    const exitCode = await runCli(["run"], { config, openRun: seam(gated()), stdio });

    expect(exitCode).toBe(EXIT_CODES.awaitingHuman);
    const output = JSON.parse(stdio.writtenOutput()) as { status: string; pending: { request: { kind: string } }[] };
    expect(output.status).toBe("waiting");
    expect(output.pending[0]?.request.kind).toBe("human_review");
  });

  it("still exits 1 when the run itself failed", async () => {
    const stdio = createFakeStdio();
    const openRun: OpenRun = () => Promise.resolve({ reason: "no origin remote" });

    const exitCode = await runCli(["run"], { config, openRun, stdio });

    expect(exitCode).toBe(EXIT_CODES.failure);
  });

  // `eligible()` is `discoverSessions`: a readdir, then a read and a sha256
  // over every transcript in this repo's project directory. The verbose trace
  // needs one to say how much of the run is left, and building that line
  // eagerly made every plain run pay for it too.
  it("costs a plain run nothing to build a trace it will not print", async () => {
    await runCli(["run"], {
      config,
      openRun: seam({ script: AUTO, session: gutteredSession() }),
      stdio: createFakeStdio(),
    });
    const quiet = eligibleCalls;

    eligibleCalls = 0;
    await runCli(["run", "--verbose"], {
      config,
      openRun: seam({ script: AUTO, session: gutteredSession() }),
      stdio: createFakeStdio(),
    });

    expect(quiet).toBeLessThan(eligibleCalls);
  });
});
