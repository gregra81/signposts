// A review answered after the transcript it was about has moved on.
//
// The developer carries on in the Claude Code session a run halted on, so by
// the time the review is answered the file has new bytes, a new mtime, and is
// not idle — it is no longer in the eligible listing. `namedSession` then has
// no recorded activity for the halted bytes, and used to fill the gap with the
// clock. That clock reading was written to `sessions.last_activity_at` and,
// with nothing else eligible, became the watermark: every transcript active
// before the moment the developer answered — the grown one included — was
// silenced for the hook for good. A watermark may only over-approximate.

import { MemorySaver } from "@langchain/langgraph";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig, type ResolvedConfig } from "../../../src/core/config/resolve.js";
import type { WorkerStatus } from "../../../src/core/worker/status.js";
import { buildExtractionGraph, type PendingRequest } from "../../../src/graph/index.js";
import type { FinishedSession, OpenRun, RunHandle, RunSession } from "../../../src/cli/run-port.js";
import type { RunOutput } from "../../../src/cli/protocol.js";
import { createFakeStdio } from "../helpers/fake-stdio.js";
import { runCli } from "../helpers/run-cli.js";
import { candidate, existingSignpost, gutteredSession, makeHarness, RUN_INPUT } from "../helpers/graph-harness.js";

const SESSION: RunSession = {
  sessionId: RUN_INPUT.sessionId,
  contentHash: RUN_INPUT.contentHash,
  transcriptPath: RUN_INPUT.transcriptPath,
  lastActivityAt: new Date("2026-09-01T09:00:00Z"),
};

const EXISTING = existingSignpost();

describe("a review answered after its transcript moved on", () => {
  let root: string;
  let repliesPath: string;
  let config: ResolvedConfig;
  let listed: RunSession[];
  let finished: FinishedSession[];

  // One harness and checkpointer for both invocations: the thread the run
  // parked has to be there for the resume to answer.
  let openRun: OpenRun;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "signposts-outlived-"));
    repliesPath = path.join(root, "replies.json");
    config = resolveConfig({ repoRoot: root, homeDir: root, repoFileContents: undefined, userFileContents: undefined, env: {} });
    listed = [SESSION];
    finished = [];

    const ports = makeHarness({
      session: gutteredSession(),
      existing: [EXISTING],
      neighbours: { t1: [EXISTING] },
      script: {
        extract: [{ candidates: [candidate()] }, { candidates: [candidate()] }],
        critic: [
          { verdicts: [{ tempId: "t1", keep: true, reason: "durable" }] },
          { verdicts: [{ tempId: "t1", keep: true, reason: "durable" }] },
        ],
        classify: [{ tempId: "t1", kind: "CONTRADICTION", relatedId: EXISTING.id, rationale: "opposite" }],
        resolve: [{ tempId: "t1", outcome: "new_wins", reasoning: "the config changed in March" }],
      },
    });
    const checkpointer = new MemorySaver();
    const handle: RunHandle = {
      repo: RUN_INPUT.repo,
      graph: buildExtractionGraph({ ports, checkpointer }),
      checkpointer,
      pendingIndex: ports.pendingIndex,
      index: ports.index,
      eligible: () => listed,
      finish: (session) => finished.push(session),
      skip: () => {},
      commitOutcome: () => null,
      syncCorpus: () => Promise.resolve({ failures: [] }),
      pendingReviews: () => Promise.resolve([]),
      close: () => {},
    };
    openRun = () => Promise.resolve({ handle });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function status(): WorkerStatus {
    return JSON.parse(readFileSync(config.paths.statuslineState, "utf8")) as WorkerStatus;
  }

  async function haltThenAnswer(): Promise<void> {
    const ran = createFakeStdio();
    await runCli(["run", "--session", SESSION.sessionId], { config, openRun, stdio: ran });
    const halted = JSON.parse(ran.writtenOutput()) as RunOutput;
    expect(halted.status).toBe("waiting");

    // The developer carried on in that session: not idle, so not listed.
    listed = [];

    const replies = Object.fromEntries(
      halted.pending.map((pending: PendingRequest) => [
        pending.id,
        Object.fromEntries(
          (pending.request as { needsHuman: { key: string }[] }).needsHuman.map((item) => [
            item.key,
            { decision: "accept", decidedAt: "2026-09-03T10:00:00.000Z" },
          ]),
        ),
      ]),
    );
    writeFileSync(repliesPath, JSON.stringify({ replies }), "utf8");

    const resumed = createFakeStdio();
    await runCli(
      ["resume", "--session", SESSION.sessionId, "--content-hash", SESSION.contentHash, "--replies", repliesPath],
      { config, openRun, stdio: resumed },
    );
    expect((JSON.parse(resumed.writtenOutput()) as RunOutput).status, resumed.writtenError()).toBe("finished");
  }

  it("does not move the watermark to the moment the review was answered", async () => {
    await haltThenAnswer();
    expect(status().lastRunFinishedAt).toBeUndefined();
  });

  it("does not record a judged entry the hook could match", async () => {
    await haltThenAnswer();
    expect(status().judgedSessions).toBeUndefined();
  });

  it("records the session as finished with its activity unknown, not as the clock", async () => {
    await haltThenAnswer();
    expect(finished).toEqual([expect.objectContaining({ sessionId: SESSION.sessionId, lastActivityAt: null })]);
  });
});
