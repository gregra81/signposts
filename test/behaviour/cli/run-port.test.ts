// The seam the run commands are handed, driven with a fake.
//
// The other CLI tests use the production `openRun` on purpose — a real
// database and a real embedder are what they are about. This one is about the
// seam itself: that the commands use what they are given, and that whatever
// was opened is closed again even when the command fails.

import { MemorySaver } from "@langchain/langgraph";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig, type ResolvedConfig } from "../../../src/core/config/resolve.js";
import { runCli } from "../helpers/run-cli.js";
import { createFakeStdio } from "../helpers/fake-stdio.js";
import type { OpenRun, RunHandle, RunSession } from "../../../src/cli/run-port.js";

const SESSIONS: RunSession[] = [
  {
    sessionId: "01SESSIONONE",
    contentHash: "hash-one",
    transcriptPath: "/transcripts/one.jsonl",
    lastActivityAt: new Date("2026-09-01T09:00:00Z"),
  },
  {
    sessionId: "01SESSIONTWO",
    contentHash: "hash-two",
    transcriptPath: "/transcripts/two.jsonl",
    lastActivityAt: new Date("2026-09-02T09:00:00Z"),
  },
];

describe("the run seam", () => {
  let repoRoot: string;
  let config: ResolvedConfig;
  let closed: number;

  const handle = (): RunHandle =>
    ({
      repo: "acme/api",
      eligible: () => SESSIONS,
      close: () => {
        closed += 1;
      },
    }) as unknown as RunHandle;

  beforeEach(() => {
    repoRoot = mkdtempSync(path.join(tmpdir(), "signposts-seam-"));
    closed = 0;
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

  it("lists what the run it was handed says is eligible", async () => {
    const stdio = createFakeStdio();
    const openRun: OpenRun = () => Promise.resolve({ handle: handle() });

    const exitCode = await runCli(["sessions"], { config, openRun, stdio });

    expect(exitCode).toBe(0);
    const output = JSON.parse(stdio.writtenOutput()) as { sessions: { sessionId: string }[] };
    expect(output.sessions.map((session) => session.sessionId)).toEqual([
      "01SESSIONONE",
      "01SESSIONTWO",
    ]);
    expect(closed).toBe(1);
  });

  it("reports why a run could not be opened, and opens nothing else", async () => {
    const stdio = createFakeStdio();
    const openRun: OpenRun = () => Promise.resolve({ reason: "no origin remote" });

    const exitCode = await runCli(["run"], { config, openRun, stdio });

    expect(exitCode).toBe(1);
    expect(stdio.writtenError()).toContain("no origin remote");
    expect(closed).toBe(0);
  });

  it("closes what it opened even when the command throws", async () => {
    const stdio = createFakeStdio();
    const openRun: OpenRun = () =>
      Promise.resolve({
        handle: {
          ...handle(),
          graph: undefined as never,
          checkpointer: new MemorySaver(),
          eligible: () => SESSIONS,
        },
      });

    // `run` with no `--replies` reaches startRun against a graph that is not
    // there; whatever it throws, the handle has to be released. The throw is
    // reported rather than escaping (src/cli/commands/run.ts, `withRun`), so
    // the release is asserted against a returned exit code, not a rejection.
    await expect(runCli(["run"], { config, openRun, stdio })).resolves.toBe(1);
    expect(closed).toBe(1);
    expect(stdio.writtenOutput()).toBe("");
  });
});
