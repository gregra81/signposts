// Durability across process death.
//
// test/behaviour/graph/interrupt.test.ts already proves a thread can be
// resumed by a second graph on fresh ports — but everything there happens in
// one process, so it cannot tell a checkpointer that writes to disk from one
// that merely looks like it does. This file spawns a real `node`, SIGKILLs it
// mid-run, and points a second process at the same file. Nothing survives the
// kill except the bytes in checkpoints.db.
//
// The run itself lives in ../helpers/checkpoint-process.ts.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCheckpointer } from "../../../src/io/db/checkpointer.js";
import { buildThreadId } from "../../../src/core/graph/thread-id.js";
import { threadConfigFor } from "../../../src/graph/index.js";
import { CHECKPOINT_FILENAME, STATE_VERSION } from "../../../src/core/config/constants.js";
import { REACHED_CLASSIFY } from "../helpers/checkpoint-process.js";
import { RUN_INPUT } from "../helpers/graph-harness.js";

const CHILD = fileURLToPath(new URL("../helpers/checkpoint-process.ts", import.meta.url));

/** Spawning `node` twice and loading LangGraph in each is seconds, not milliseconds. */
const TIMEOUT_MS = 60_000;

interface Verdict {
  disposition: string;
  extractCalls: number;
  committed: number;
}

let stateDir: string;
let checkpointPath: string;
let children: ChildProcessWithoutNullStreams[];

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "signposts-kill-"));
  checkpointPath = path.join(stateDir, CHECKPOINT_FILENAME);
  children = [];
});

afterEach(() => {
  for (const child of children) {
    child.kill("SIGKILL");
  }
  rmSync(stateDir, { recursive: true, force: true });
});

function start(mode: "hang" | "resume", dbPath: string): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [CHILD, mode, dbPath], { stdio: "pipe" });
  children.push(child);
  child.stderr.setEncoding("utf8");
  return child;
}

/**
 * Resolves on the first stdout line containing `marker`, rejecting if the
 * process ends without printing one.
 *
 * The failure listener is `close`, not `exit`: `exit` fires when the process
 * terminates, which for a child that prints its verdict and returns happens
 * before the parent has drained the pipe — so a successful run would be
 * reported as one that printed nothing. `close` fires once stdio is done.
 *
 * stderr is buffered separately. It only ever appears in the error message;
 * merging it into `stdout` would let a Node warning splice itself into the
 * middle of the JSON line the caller parses.
 */
function waitForLine(child: ChildProcessWithoutNullStreams, marker: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
      const line = out.split("\n").find((candidate) => candidate.includes(marker));
      if (line !== undefined) {
        resolve(line);
      }
    });
    child.stderr.on("data", (chunk: string) => {
      err += chunk;
    });
    child.on("close", () => {
      reject(new Error(`child ended before printing ${marker}:\nstdout: ${out}\nstderr: ${err}`));
    });
  });
}

/** Kills a running child outright and waits for the OS to confirm it is gone. */
function sigkill(child: ChildProcessWithoutNullStreams): Promise<NodeJS.Signals | null> {
  const dead = new Promise<NodeJS.Signals | null>((resolve) => {
    child.on("exit", (_code, signal) => {
      resolve(signal);
    });
  });
  child.kill("SIGKILL");
  return dead;
}

/** Runs a child to completion and returns the verdict it printed. */
async function runToCompletion(dbPath: string): Promise<Verdict> {
  const child = start("resume", dbPath);
  const line = await waitForLine(child, "disposition");
  return JSON.parse(line) as Verdict;
}

/** Starts a run in another process and kills it once it reaches `classify`. */
async function killMidRun(): Promise<void> {
  const child = start("hang", checkpointPath);
  await waitForLine(child, REACHED_CLASSIFY);
  expect(await sigkill(child)).toBe("SIGKILL");
}

describe("a run killed mid-classification", () => {
  it(
    "leaves its progress in the checkpoint file, not in the dead process",
    async () => {
      await killMidRun();

      expect(existsSync(checkpointPath)).toBe(true);
      // Read back through a third connection: the checkpoint is on disk, at
      // this build's state version, under the thread id the run computed.
      const { checkpointer, close } = openCheckpointer(checkpointPath);
      const tuple = await checkpointer.getTuple(threadConfigFor(buildThreadId(RUN_INPUT)));
      close();

      expect(tuple?.checkpoint.channel_values).toMatchObject({
        version: STATE_VERSION,
        candidates: [expect.objectContaining({ tempId: "t1" })],
      });
    },
    TIMEOUT_MS,
  );

  it(
    "is resumed by a fresh process on the same file, without extracting again",
    async () => {
      await killMidRun();

      const verdict = await runToCompletion(checkpointPath);

      expect(verdict).toEqual({ disposition: "resumed", extractCalls: 0, committed: 1 });
    },
    TIMEOUT_MS,
  );

  // The control. Same script, same assertions, no checkpoint file behind it:
  // if this also reported "resumed" the test above would be proving nothing.
  it(
    "starts from the beginning when there is no checkpoint file to resume",
    async () => {
      const verdict = await runToCompletion(path.join(stateDir, "unused.db"));

      expect(verdict).toEqual({ disposition: "fresh", extractCalls: 1, committed: 1 });
    },
    TIMEOUT_MS,
  );
});
