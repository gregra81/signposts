// A transcript that can never be extracted, among ones that can
// (19-value-to-a-user.md, items 1 and 2; Phase 3's exit test).
//
// Before this, one empty `.jsonl` was enough to break the loop for good. The
// gutter threw, `withRun` turned the throw into exit 1 with nothing on stdout,
// and the session was never recorded — so it stayed eligible, and the
// SessionStart hook, which counts by mtime past a watermark that only moves
// once the whole backlog drains, announced every transcript in the backlog
// again at the next session start. Then did it again the day after.
//
// The run seam is a fake so the graph runs on a scripted model; the transcript
// files are real, because the count that has to go down is the one the hook
// takes from the directory with its own functions.

import { MemorySaver } from "@langchain/langgraph";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT_CODES } from "../../../src/core/cli/exit-codes.js";
import { resolveConfig, type ResolvedConfig } from "../../../src/core/config/resolve.js";
import { UnusableTranscriptError } from "../../../src/core/errors/unusable-transcript.js";
import { projectDirName } from "../../../src/core/transcript/project-dir.js";
import type { WorkerStatus } from "../../../src/core/worker/status.js";
import { buildExtractionGraph } from "../../../src/graph/index.js";
import type { OpenRun, RunHandle, RunSession } from "../../../src/cli/run-port.js";
import { countEligibleSessions, derivePaths, judgedSessions, watermarkMs } from "../../../hooks/session-start.ts";
import { createFakeStdio } from "../helpers/fake-stdio.js";
import { runCli } from "../helpers/run-cli.js";
import { gutteredSession, makeHarness, type FakeGutterPort } from "../helpers/graph-harness.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A session the handle recorded, and which of its two methods recorded it. */
interface JudgedSession {
  sessionId: string;
  contentHash: string;
  outcome: "done" | "skipped";
}

describe("an unusable transcript among usable ones", () => {
  let homeDir: string;
  let repoRoot: string;
  let config: ResolvedConfig;
  let sessions: RunSession[];
  /** What the handle has recorded, across invocations — the `sessions` table's stand-in. */
  let judged: JudgedSession[];
  let gutterThrows: (transcriptPath: string) => Error | undefined;

  const [GOOD_1, BAD, GOOD_2] = ["good-1", "bad", "good-2"];

  function session(id: string): RunSession {
    return sessions.find((s) => s.sessionId === id)!;
  }

  /** A run seam that answers `eligible` the way the real one does: judged sessions drop out of it. */
  const openRun: OpenRun = () => {
    const ports = makeHarness({ script: { extract: [{ candidates: [] }], critic: [{ verdicts: [] }] }, session: gutteredSession() });
    const real = ports.gutter;
    ports.gutter = {
      gutter: (transcriptPath: string) => {
        const error = gutterThrows(transcriptPath);
        return error === undefined ? real.gutter(transcriptPath) : Promise.reject(error);
      },
    } as FakeGutterPort;
    const checkpointer = new MemorySaver();
    const handle: RunHandle = {
      repo: "acme/api",
      graph: buildExtractionGraph({ ports, checkpointer }),
      checkpointer,
      pendingIndex: ports.pendingIndex,
      index: ports.index,
      eligible: () => sessions.filter((s) => !judged.some((done) => done.sessionId === s.sessionId)),
      finish: (s) => judged.push({ ...s, outcome: "done" }),
      skip: (s) => judged.push({ ...s, outcome: "skipped" }),
      commitOutcome: () => null,
      syncCorpus: () => Promise.resolve({ failures: [] }),
      pendingReviews: () => Promise.resolve([]),
      close: () => {},
    };
    return Promise.resolve({ handle });
  };

  function hookCount(): number {
    const paths = derivePaths(repoRoot, homeDir);
    const state = JSON.parse(readFileSync(config.paths.statuslineState, "utf8")) as WorkerStatus;
    return countEligibleSessions(paths, Date.now(), watermarkMs(state), judgedSessions(state));
  }

  async function run(id: string) {
    const stdio = createFakeStdio();
    const code = await runCli(["run", "--session", id], { config, openRun, stdio });
    return { code, stdio };
  }

  beforeEach(() => {
    homeDir = mkdtempSync(path.join(tmpdir(), "signposts-unusable-home-"));
    repoRoot = mkdtempSync(path.join(tmpdir(), "signposts-unusable-repo-"));
    config = resolveConfig({ repoRoot, homeDir, repoFileContents: undefined, userFileContents: undefined, env: {} });
    judged = [];
    gutterThrows = (transcriptPath) =>
      transcriptPath.endsWith(`${BAD}.jsonl`)
        ? new UnusableTranscriptError(`${transcriptPath}: no usable transcript lines`)
        : undefined;

    // Three real transcripts, a few days idle and a few seconds apart, where the
    // hook looks for them. Whole-millisecond mtimes, because a session's
    // recorded activity is the file's mtime and the hook matches on it.
    const projectDir = path.join(derivePaths(repoRoot, homeDir).transcriptRoot, projectDirName(repoRoot));
    mkdirSync(projectDir, { recursive: true });
    const base = Math.floor(Date.now() / 1000) * 1000 - 3 * DAY_MS;
    sessions = [GOOD_1, BAD, GOOD_2].map((id, i) => {
      const transcriptPath = path.join(projectDir, `${id}.jsonl`);
      writeFileSync(transcriptPath, id === BAD ? "" : "{}\n");
      const lastActivityAt = new Date(base + i * 1000);
      utimesSync(transcriptPath, lastActivityAt, lastActivityAt);
      return { sessionId: id, contentHash: `hash-${id}`, transcriptPath, lastActivityAt };
    });
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("reports the unusable one as skipped, on stdout, without failing", async () => {
    const { code, stdio } = await run(BAD);

    // One JSON object, as for every other outcome, so the subagent driving the
    // loop has something to report beyond an exit code.
    expect(JSON.parse(stdio.writtenOutput())).toMatchObject({
      sessionId: BAD,
      contentHash: "hash-bad",
      status: "skipped",
      reason: expect.stringContaining("no usable transcript lines"),
      pending: [],
      proposed: [],
      commit: null,
    });
    // Not 1: the skill treats 1 as "signposts crashed", and an empty file is not that.
    expect(code).toBe(EXIT_CODES.ok);
  });

  it("does not offer it again", async () => {
    await run(BAD);

    const stdio = createFakeStdio();
    await runCli(["sessions"], { config, openRun, stdio });
    const listed = (JSON.parse(stdio.writtenOutput()) as { sessions: { sessionId: string }[] }).sessions;

    expect(listed.map((s) => s.sessionId)).toEqual([GOOD_1, GOOD_2]);
    expect(judged).toEqual([expect.objectContaining({ sessionId: BAD, contentHash: "hash-bad", outcome: "skipped" })]);
  });

  it("lets the usable ones finish around it", async () => {
    const first = await run(GOOD_1);
    expect(first.stdio.writtenError()).toBe("");
    expect(first.code).toBe(EXIT_CODES.ok);
    expect((await run(BAD)).code).toBe(EXIT_CODES.ok);
    const { code, stdio } = await run(GOOD_2);

    expect(code).toBe(EXIT_CODES.ok);
    expect(JSON.parse(stdio.writtenOutput())).toMatchObject({ sessionId: GOOD_2, status: "finished" });
    expect(judged.map((s) => s.sessionId)).toEqual([GOOD_1, BAD, GOOD_2]);
  });

  it("brings the hook's count down as sessions are judged, before the backlog drains", async () => {
    await run(BAD);
    // Item 2: the watermark cannot move yet — two transcripts are still waiting,
    // and moving it would bury them. The hook still has to stop counting this one.
    expect(hookCount()).toBe(2);

    await run(GOOD_1);
    expect(hookCount()).toBe(1);

    await run(GOOD_2);
    expect(hookCount()).toBe(0);
  });

  it("counts a judged transcript again once it has grown", async () => {
    await run(GOOD_1);
    expect(hookCount()).toBe(2);

    // The developer resumed that Claude Code session: new bytes, a new content
    // hash, a new mtime. It is a different transcript and deserves a look.
    const grown = session(GOOD_1);
    const later = new Date(grown.lastActivityAt.getTime() + 60_000);
    utimesSync(grown.transcriptPath, later, later);

    expect(hookCount()).toBe(3);
  });

  it("leaves a session eligible when the failure is not a property of the transcript", async () => {
    // A disk error, a lock, a bug: not deterministic, so not safe to record as
    // judged. It stays a failure and stays eligible to be retried.
    gutterThrows = (transcriptPath) =>
      transcriptPath.endsWith(`${GOOD_1}.jsonl`) ? new Error("EIO: i/o error, read") : undefined;

    const { code, stdio } = await run(GOOD_1);

    expect(code).toBe(EXIT_CODES.failure);
    expect(stdio.writtenError()).toContain("EIO");
    expect(judged).toEqual([]);
  });
});
