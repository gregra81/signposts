// Behaviour tests for the shipped SessionStart hook: the compiled
// `hooks/session-start.js`, run as its own process the way Claude Code runs
// it, against a real repo, a real home directory and a real detached spawn.
//
// The acceptance criteria in 07-triggering-and-ux.md are written about the
// process, not about the functions — "exits in under 50ms and emits nothing",
// "starting three sessions concurrently produces exactly one worker" — so
// nothing here imports the module. `pnpm build:hooks` runs first, because the
// artifact under test is the build output.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { IDLE_HOURS, LOCK_STALE_MINUTES } from "../../../src/core/config/constants.ts";
import type { WorkerStatus } from "../../../src/core/worker/status.ts";
import { serialiseSignpost } from "../../../src/core/signpost/codec.ts";
import { testLocalModelPath } from "../../support/model-cache.ts";
import { hashRepoRoot } from "../../../src/core/config/paths.ts";
import { projectDirName } from "../../../src/core/transcript/project-dir.ts";

const ROOT = path.dirname(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))));
const HOOK = path.join(ROOT, "hooks", "session-start.js");

const HOUR_MS = 3_600_000;
/** How long the stub worker waits before recording itself — longer than the hook lives. */
const WORKER_DELAY_MS = 250;
const MINUTE_MS = 60_000;

beforeAll(() => {
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "build-hooks.mjs")], { stdio: "pipe" });
});

interface Fixture {
  repoRoot: string;
  home: string;
  configDir: string;
  stateDir: string;
  projectDir: string;
  /** Every worker start appends a line here, so "exactly one worker" is countable. */
  workerLog: string;
  worker: string;
}

/** A git repo with `.signposts/`, an isolated home, and a worker that records that it ran. */
function fixture(): Fixture {
  // realpath, because that is what the hook and the worker both key their
  // state directory on: on macOS mkdtemp hands back a /var path that is a
  // symlink to /private/var, and `process.cwd()` in the spawned worker would
  // report the second. A fixture computing stateDir from the first would be
  // watching a directory neither process ever writes to.
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "signposts-hook-")));
  const repoRoot = path.join(base, "repo");
  const home = path.join(base, "home");
  const configDir = path.join(base, "claude");
  const stateDir = path.join(home, ".signposts", hashRepoRoot(repoRoot));
  const projectDir = path.join(configDir, "projects", projectDirName(repoRoot));
  const workerLog = path.join(base, "worker.log");
  const worker = path.join(base, "worker.js");

  mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
  mkdirSync(path.join(repoRoot, ".signposts"), { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  const index = path.join(repoRoot, ".signposts", "index.md");
  writeFileSync(index, "# index\n");
  // Backdated so `withCurrentIndex` can leave the database at "now" and still
  // be newer than the corpus. Filesystem mtimes here are sub-millisecond
  // apart otherwise, and the staleness check is a strict comparison.
  const anHourAgo = new Date(Date.now() - HOUR_MS);
  utimesSync(index, anHourAgo, anHourAgo);
  // appendFileSync rather than a write: three workers would otherwise be
  // indistinguishable from one. The delay outlasts the hook, so every test
  // that sees a line also proves the worker survived its parent's exit.
  writeFileSync(
    worker,
    `setTimeout(() => require("node:fs").appendFileSync(${JSON.stringify(workerLog)}, process.pid + "\\n"), ${WORKER_DELAY_MS});\n`,
  );

  return { repoRoot, home, configDir, stateDir, projectDir, workerLog, worker };
}

/** Marks the index current: a database newer than everything under `.signposts/`. */
function withCurrentIndex(f: Fixture): Fixture {
  mkdirSync(f.stateDir, { recursive: true });
  writeFileSync(path.join(f.stateDir, "signposts.db"), "");
  return f;
}

/** A transcript last touched `hoursAgo`, which is what the idle gate reads. */
function withTranscript(f: Fixture, id: string, hoursAgo: number): Fixture {
  const transcript = path.join(f.projectDir, `${id}.jsonl`);
  writeFileSync(transcript, "{}\n");
  const when = new Date(Date.now() - hoursAgo * HOUR_MS);
  utimesSync(transcript, when, when);
  return f;
}

function writeWorkerState(f: Fixture, state: Record<string, unknown>): Fixture {
  mkdirSync(f.stateDir, { recursive: true });
  writeFileSync(path.join(f.stateDir, "status.json"), JSON.stringify(state));
  return f;
}

function runHook(f: Fixture, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [HOOK], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: f.home,
      CLAUDE_PROJECT_DIR: f.repoRoot,
      CLAUDE_CONFIG_DIR: f.configDir,
      SIGNPOSTS_WORKER: f.worker,
      ...extraEnv,
    },
  });
}

/** Detached workers outlive the hook, so their side effect has to be waited for. */
async function workerLines(f: Fixture, expected: number): Promise<string[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const lines = existsSync(f.workerLog)
      ? readFileSync(f.workerLog, "utf8").split("\n").filter(Boolean)
      : [];
    if (lines.length >= expected) {
      return lines;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return existsSync(f.workerLog) ? readFileSync(f.workerLog, "utf8").split("\n").filter(Boolean) : [];
}

/**
 * Polls until `done()` holds, or gives up quietly and lets the caller assert.
 *
 * A detached worker finishes on its own schedule, so every end state one
 * leaves behind has to be waited for rather than read once.
 */
async function waitUntil(done: () => boolean, attempts = 600, intervalMs = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts && !done(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe("silence when there is nothing to do", () => {
  it("emits nothing in a repo where init never ran", () => {
    const f = fixture();
    rmSync(path.join(f.repoRoot, ".signposts"), { recursive: true });
    const result = runHook(f);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    // R3: no state, and above all no database, before consent.
    expect(existsSync(f.stateDir)).toBe(false);
  });

  it("emits nothing outside a git repo", () => {
    const f = fixture();
    rmSync(path.join(f.repoRoot, ".git"), { recursive: true });
    expect(runHook(f).stdout).toBe("");
  });

  it("emits nothing with no eligible sessions, no threads, and a current index", () => {
    const f = withTranscript(withCurrentIndex(fixture()), "busy", IDLE_HOURS - 1);
    const result = runHook(f);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(existsSync(path.join(f.stateDir, "run.lock"))).toBe(false);
  });

  it("takes no lock and says nothing when the worker is not installed", async () => {
    const f = withTranscript(fixture(), "old", IDLE_HOURS + 1);
    const result = runHook(f, { SIGNPOSTS_WORKER: path.join(f.repoRoot, "absent.js") });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(existsSync(path.join(f.stateDir, "run.lock"))).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, WORKER_DELAY_MS * 2));
    expect(existsSync(f.workerLog)).toBe(false);
  });
});

describe("the three wake conditions", () => {
  it("wakes on an eligible session", async () => {
    const f = withTranscript(withCurrentIndex(fixture()), "yesterday", IDLE_HOURS + 1);
    const result = runHook(f);

    expect(JSON.parse(result.stdout)).toEqual({
      systemMessage: "🪧 signposts: 1 session ready — run `signpost run`",
    });
    // The hook has already exited; the detached worker has not yet run.
    expect(existsSync(f.workerLog)).toBe(false);
    expect(await workerLines(f, 1)).toHaveLength(1);
  });

  it("wakes on a resumable thread the worker recorded", async () => {
    const f = withCurrentIndex(fixture());
    writeWorkerState(f, { threadsWaiting: 2 });

    expect(JSON.parse(runHook(f).stdout)).toEqual({
      systemMessage: "🪧 signposts: 2 changes need your review — run `signpost review`",
    });
    expect(await workerLines(f, 1)).toHaveLength(1);
  });

  // 05-retrieval.md: the third condition is local and free, so a cold clone
  // gets its index without a credential ever being read.
  it("wakes on a missing index — the cold-clone case", async () => {
    const f = fixture();
    expect(existsSync(f.stateDir)).toBe(false);

    expect(JSON.parse(runHook(f).stdout)).toEqual({
      systemMessage: "🪧 signposts: rebuilding the search index in the background",
    });
    expect(await workerLines(f, 1)).toHaveLength(1);
  });

  it("wakes on a signpost newer than the index — the git-pull case", async () => {
    const f = withCurrentIndex(fixture());
    mkdirSync(path.join(f.repoRoot, ".signposts", "decision"), { recursive: true });
    const pulled = path.join(f.repoRoot, ".signposts", "decision", "pulled.md");
    writeFileSync(pulled, "---\n---\n");
    // Stated rather than relied on. Both files are written within the same
    // moment, and `indexIsStale` compares them with a strict `>`: on a
    // filesystem whose timestamps are coarser than the gap — CI's — the pull
    // is not newer than the index, and the hook correctly finds nothing to do.
    const anHourOn = new Date(Date.now() + HOUR_MS);
    utimesSync(pulled, anHourOn, anHourOn);

    expect(JSON.parse(runHook(f).stdout).systemMessage).toBe(
      "🪧 signposts: rebuilding the search index in the background",
    );
    expect(await workerLines(f, 1)).toHaveLength(1);
  });

  // The watermark is what stands in for the database's processed keys.
  it("stops waking for a session the last finished run already saw", () => {
    const f = withTranscript(withCurrentIndex(fixture()), "done", IDLE_HOURS + 2);
    writeWorkerState(f, { lastRunFinishedAt: new Date(Date.now() - HOUR_MS).toISOString() });

    expect(runHook(f).stdout).toBe("");
  });
});

describe("the lockfile", () => {
  it("produces exactly one worker when three sessions start at once", async () => {
    const f = withTranscript(withCurrentIndex(fixture()), "yesterday", IDLE_HOURS + 1);

    const hooks = [0, 1, 2].map(
      () =>
        new Promise<string>((resolve) => {
          const child = spawn(process.execPath, [HOOK], {
            env: {
              ...process.env,
              HOME: f.home,
              CLAUDE_PROJECT_DIR: f.repoRoot,
              CLAUDE_CONFIG_DIR: f.configDir,
              SIGNPOSTS_WORKER: f.worker,
            },
            stdio: ["ignore", "pipe", "ignore"],
          });
          let stdout = "";
          child.stdout.on("data", (chunk) => (stdout += String(chunk)));
          child.on("close", () => resolve(stdout));
        }),
    );
    const outputs = await Promise.all(hooks);

    expect(outputs.filter((out) => out !== "")).toHaveLength(1);
    // Give the two that lost the race every chance to have spawned anyway.
    await new Promise((resolve) => setTimeout(resolve, WORKER_DELAY_MS * 2));
    expect(await workerLines(f, 1)).toHaveLength(1);
  });

  it("stays quiet while a fresh lock is held", async () => {
    const f = withTranscript(withCurrentIndex(fixture()), "yesterday", IDLE_HOURS + 1);
    mkdirSync(f.stateDir, { recursive: true });
    writeFileSync(path.join(f.stateDir, "run.lock"), JSON.stringify({ pid: 1 }));

    expect(runHook(f).stdout).toBe("");
    await new Promise((resolve) => setTimeout(resolve, WORKER_DELAY_MS * 2));
    expect(existsSync(f.workerLog)).toBe(false);
  });

  // The worker stamps its own pid at `takeLock({adopt: true})`, which is a
  // whole `production-app` import away — a second in which the lock named this
  // hook, a process that has already exited. The pid check both sides now do
  // read that as a dead worker's lock, so a session starting in that window
  // unlinked it and spawned a second worker onto the same rows. The stub here
  // adopts nothing and sleeps, which is exactly that window held open.
  it("leaves the lock naming the worker it spawned, not itself", async () => {
    const f = withTranscript(withCurrentIndex(fixture()), "yesterday", IDLE_HOURS + 1);
    const lockfile = path.join(f.stateDir, "run.lock");

    expect(runHook(f).stdout).not.toBe("");
    const holder = JSON.parse(readFileSync(lockfile, "utf8")).pid as number;

    // A second session start, inside the window: the lock is held by a live
    // process, so it says nothing and spawns nothing.
    expect(runHook(f).stdout).toBe("");

    const lines = await workerLines(f, 1);
    expect(lines).toHaveLength(1);
    expect(holder).toBe(Number(lines[0]));
  });

  it("takes over a lock older than LOCK_STALE_MINUTES", async () => {
    const f = withTranscript(withCurrentIndex(fixture()), "yesterday", IDLE_HOURS + 1);
    mkdirSync(f.stateDir, { recursive: true });
    const lockfile = path.join(f.stateDir, "run.lock");
    writeFileSync(lockfile, JSON.stringify({ pid: 1 }));
    const dead = new Date(Date.now() - (LOCK_STALE_MINUTES + 1) * MINUTE_MS);
    utimesSync(lockfile, dead, dead);

    expect(runHook(f).stdout).not.toBe("");
    expect(await workerLines(f, 1)).toHaveLength(1);
    // Taken over, not merely ignored: the lock now names its new holder.
    expect(JSON.parse(readFileSync(lockfile, "utf8")).pid).not.toBe(1);
  });
});

describe("the budget", () => {
  // 15-spec.md: HOOK_BUDGET_MS is "a target to measure early, not an
  // assertion". This asserted it anyway, three ways, and a shared CI runner
  // failed all three with the hook unchanged:
  //
  //   total wall clock  < 50ms      -> 58.5ms, where bare `node -e ""` was 40ms
  //   total minus bare node < 25ms  -> 28.7ms, because the hook's extra work is
  //                                   `stat` calls and slow IO inflates those too
  //   total / bare node < 2         -> 2.11x, under enough contention
  //
  // Every form of it grades the machine, because every form of it is a clock
  // reading taken on someone else's hardware. scripts/measure-hook.mjs is where
  // the budget is watched, on a real machine, by a person who can read a
  // distribution — which is what 15-spec.md asked for in the first place.
  //
  // What a suite can hold is the thing that would actually blow the budget: an
  // import. Node start-up dominates the number, our own work is a handful of
  // `stat` calls, and the way that changes is somebody adding a dependency to
  // the hook — tens of milliseconds of resolve and parse, paid on every session
  // start. That is deterministic, so it is what this asserts. The no-src-import
  // lint rule covers `src/`; this covers `node_modules` too.
  it("imports nothing but Node builtins, which is the whole of its budget", () => {
    const bundle = readFileSync(HOOK, "utf8");
    const specifiers = [...bundle.matchAll(/^\s*import[^"']*?from\s*["']([^"']+)["']/gm)].map(
      (match) => match[1]!,
    );

    // Guard the regex as much as the bundle: a pattern that matched nothing
    // would pass this test on any input, including a hook that imports half of
    // npm.
    expect(specifiers.length).toBeGreaterThanOrEqual(4);
    expect(specifiers.filter((specifier) => !specifier.startsWith("node:"))).toEqual([]);
  });
});
