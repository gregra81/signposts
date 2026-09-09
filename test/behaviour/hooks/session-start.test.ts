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
import { HOOK_BUDGET_MS, IDLE_HOURS, LOCK_STALE_MINUTES } from "../../../src/core/config/constants.ts";
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
  // assertion". This measures the shipped process end to end on whatever
  // hardware runs the suite, and reports the bare-node baseline alongside,
  // because most of the number is Node's own start-up. The ceiling is p50
  // rather than max so an unlucky scheduling slice on a loaded CI box does
  // not fail an otherwise healthy hook; scripts/measure-hook.mjs prints the
  // full distribution.
  it("exits inside HOOK_BUDGET_MS with nothing to do", () => {
    const f = withTranscript(withCurrentIndex(fixture()), "busy", IDLE_HOURS - 1);
    runHook(f); // warm the page cache

    const samples: number[] = [];
    const baselines: number[] = [];
    for (let i = 0; i < 15; i += 1) {
      const startedHook = process.hrtime.bigint();
      runHook(f);
      samples.push(Number(process.hrtime.bigint() - startedHook) / 1e6);

      const startedBaseline = process.hrtime.bigint();
      spawnSync(process.execPath, ["-e", ""]);
      baselines.push(Number(process.hrtime.bigint() - startedBaseline) / 1e6);
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

    const hookMedian = median(samples);
    console.log(
      `session-start hook: p50 ${hookMedian.toFixed(1)}ms, bare node ${median(baselines).toFixed(1)}ms, budget ${HOOK_BUDGET_MS}ms`,
    );
    expect(hookMedian).toBeLessThan(HOOK_BUDGET_MS);
  });
});

// The whole point of the hook: it wakes something that does real work. Every
// test above stubs the worker, because what they are about is the hook's own
// decisions and its wall-clock budget. This one lets the two meet — the real
// `signpost worker`, spawned by the real hook, in a repo that has signposts
// and no index.
describe("the hook and the worker together", () => {
  it(
    "builds a cold clone's index in the background, after the hook has exited",
    async () => {
      const f = fixture();
      execFileSync("git", ["init", "-q"], { cwd: f.repoRoot });
      execFileSync("git", ["remote", "add", "origin", "git@github.com:test/repo.git"], {
        cwd: f.repoRoot,
      });
      execFileSync("git", ["config", "user.email", "dev@acme.example"], { cwd: f.repoRoot });
      writeFileSync(
        path.join(f.repoRoot, ".signposts", "staging.md"),
        serialiseSignpost({
          id: "staging-read-only",
          claim: "Staging is read only outside the ETL window",
          category: "gotcha",
          scope: { repo: "test/repo" },
          evidence: "A migration failed with a permissions error.",
          confidence: 0.9,
          provenance: {
            session_ids: ["s-1"],
            authors: ["dev@acme.example"],
            first_seen: "2026-01-01",
            last_reinforced: "2026-01-01",
          },
          status: "active",
        }),
      );

      // No SIGNPOSTS_WORKER: this resolves the real bin/signpost.js.
      const result = spawnSync(process.execPath, [HOOK], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: f.home,
          CLAUDE_PROJECT_DIR: f.repoRoot,
          CLAUDE_CONFIG_DIR: f.configDir,
          // The suite runs with the network denied; the worker loads an
          // embedder, so point it at the copy global-setup.ts prepared.
          SIGNPOSTS_RETRIEVAL_ALLOW_REMOTE_MODELS: "false",
          // Absolute: the worker runs with the repo as its cwd, so a path
          // relative to this suite's would resolve to nothing there.
          SIGNPOSTS_RETRIEVAL_LOCAL_MODEL_PATH: path.resolve(testLocalModelPath()),
        },
      });

      expect(result.stdout).toContain("rebuilding the search index in the background");

      // Wait for the worker's own terminal state, not for the database file:
      // `openDb` creates that within milliseconds and the indexing runs on
      // well after it.
      const statusPath = path.join(f.stateDir, "status.json");
      let status: WorkerStatus | undefined;
      for (let attempt = 0; attempt < 600; attempt += 1) {
        status = existsSync(statusPath)
          ? (JSON.parse(readFileSync(statusPath, "utf8")) as WorkerStatus)
          : undefined;
        if (status?.phase === "idle") {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      expect(existsSync(path.join(f.stateDir, "signposts.db"))).toBe(true);
      expect(status?.phase).toBe("idle");
      expect(status?.lastError).toBeUndefined();
      // Handed over and released: the next session start is not locked out.
      expect(existsSync(path.join(f.stateDir, "run.lock"))).toBe(false);
    },
    180_000,
  );
});
