// @ts-check
// What the SessionStart hook actually costs, on this machine, wall-clock.
//
// 15-spec.md: "Node's own process start is a large fraction of
// HOOK_BUDGET_MS, so treat that constant as a target to measure early, not an
// assertion." So this measures rather than asserts: it spawns the shipped
// `hooks/session-start.js` end to end, the way Claude Code does, and prints
// the distribution next to a bare `node -e ""` baseline. A hook that is fast
// only in-process has measured the wrong thing.
//
// Three scenarios, cheapest first:
//
//   uninitialised  repo with no `.signposts/` — the first gate, and the one
//                  every repo on the machine that never ran `init` takes
//   idle           initialised, nothing eligible: the common case, and the
//                  one 07's acceptance criterion is written against
//   work           eligible transcript + stale index + a stub worker to
//                  spawn, so the detached spawn and the notice are included
//
// Run: `node scripts/measure-hook.mjs [iterations]`

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOOK = path.join(ROOT, "hooks", "session-start.js");

/** 13-constants.md. Duplicated here for the same reason the hook duplicates it. */
const HOOK_BUDGET_MS = 50;
const IDLE_HOURS = 24;

const ITERATIONS = Number(process.argv[2] ?? 30);
const DAY_MS = 86_400_000;

// realpath: the hook resolves the repo root through symlinks (so that it and
// the worker key the same state directory), and on macOS mkdtemp hands back a
// /var path that is a symlink to /private/var. Without this, the stateDir
// computed below is not the one the hook uses, and the per-iteration lock
// reset clears a file nothing ever wrote.
const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), "signposts-hook-measure-")));
process.on("exit", () => rmSync(workspace, { recursive: true, force: true }));

/**
 * A repo, a fake `~`, and a fake Claude Code config directory.
 * @param {string} name
 */
function scenario(name) {
  const base = path.join(workspace, name);
  const repoRoot = path.join(base, "repo");
  const home = path.join(base, "home");
  const configDir = path.join(base, "claude");
  mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
  mkdirSync(home, { recursive: true });
  const stateDir = path.join(
    home,
    ".signposts",
    createHash("sha256").update(repoRoot).digest("hex").slice(0, 12),
  );
  return { base, repoRoot, home, configDir, stateDir };
}

/**
 * Transcripts live in a directory named after the repo path, non-alphanumerics dashed.
 * @param {string} repoRoot
 */
function projectDirName(repoRoot) {
  return repoRoot.replace(/\/+$/, "").replace(/[^a-zA-Z0-9]/g, "-");
}

const uninitialised = scenario("uninitialised");

const idle = scenario("idle");
mkdirSync(path.join(idle.repoRoot, ".signposts"), { recursive: true });
writeFileSync(path.join(idle.repoRoot, ".signposts", "index.md"), "# index\n");
mkdirSync(idle.stateDir, { recursive: true });
// A database newer than the corpus: the index is current, so nothing is stale.
writeFileSync(path.join(idle.stateDir, "signposts.db"), "");
// One transcript, active minutes ago — inside the idle gate, so not eligible.
const idleProject = path.join(idle.configDir, "projects", projectDirName(idle.repoRoot));
mkdirSync(idleProject, { recursive: true });
writeFileSync(path.join(idleProject, "aaaa.jsonl"), "{}\n");

const work = scenario("work");
mkdirSync(path.join(work.repoRoot, ".signposts"), { recursive: true });
writeFileSync(path.join(work.repoRoot, ".signposts", "index.md"), "# index\n");
const workProject = path.join(work.configDir, "projects", projectDirName(work.repoRoot));
mkdirSync(workProject, { recursive: true });
const transcript = path.join(workProject, "bbbb.jsonl");
writeFileSync(transcript, "{}\n");
// Older than IDLE_HOURS, so the hook counts it as eligible.
const stale = new Date(Date.now() - (IDLE_HOURS + 1) * 3_600_000);
utimesSync(transcript, stale, stale);
// A worker that exits immediately: this measures the hook's spawn, not a run.
const stubWorker = path.join(work.base, "worker.js");
writeFileSync(stubWorker, "process.exit(0);\n");

/**
 * @param {{repoRoot: string, home: string, configDir: string}} target
 * @param {Record<string, string>} extra
 */
function envFor(target, extra = {}) {
  return {
    ...process.env,
    HOME: target.home,
    CLAUDE_PROJECT_DIR: target.repoRoot,
    CLAUDE_CONFIG_DIR: target.configDir,
    ...extra,
  };
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 */
function timeOnce(argv, env) {
  const started = process.hrtime.bigint();
  const result = spawnSync(process.execPath, argv, { env, encoding: "utf8" });
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  return { elapsed, stdout: result.stdout ?? "" };
}

/**
 * `reset` runs before every iteration and is not timed. The work scenario
 * needs it: the first run takes the lock, and every run after it would
 * otherwise measure the lock-held early exit instead of the spawn.
 *
 * @param {string} label
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @param {() => void} [reset]
 */
function measure(label, argv, env, reset = () => {}) {
  reset();
  timeOnce(argv, env); // warm the page cache; the first spawn pays for everyone
  /** @type {number[]} */
  const samples = [];
  let stdout = "";
  for (let i = 0; i < ITERATIONS; i += 1) {
    reset();
    const run = timeOnce(argv, env);
    samples.push(run.elapsed);
    stdout = run.stdout;
  }
  samples.sort((a, b) => a - b);
  const at = (/** @type {number} */ q) =>
    samples[Math.min(samples.length - 1, Math.floor(samples.length * q))] ?? 0;
  return { label, min: at(0), p50: at(0.5), p95: at(0.95), max: at(1), stdout };
}

const results = [
  measure("node -e '' (baseline)", ["-e", ""], process.env),
  measure("uninitialised", [HOOK], envFor(uninitialised)),
  measure("idle (nothing to do)", [HOOK], envFor(idle)),
  measure("work (spawns worker)", [HOOK], envFor(work, { SIGNPOSTS_WORKER: stubWorker }), () =>
    rmSync(path.join(work.stateDir, "run.lock"), { force: true }),
  ),
  measure("work, lock held", [HOOK], envFor(work, { SIGNPOSTS_WORKER: stubWorker })),
];

const width = Math.max(...results.map((r) => r.label.length));
console.log(`HOOK_BUDGET_MS = ${HOOK_BUDGET_MS}, ${ITERATIONS} iterations, node ${process.version}\n`);
console.log(`${"scenario".padEnd(width)}   min     p50     p95     max`);
for (const r of results) {
  const cells = [r.min, r.p50, r.p95, r.max].map((v) => v.toFixed(1).padStart(6)).join("  ");
  const over = r.p95 > HOOK_BUDGET_MS ? "  OVER BUDGET" : "";
  console.log(`${r.label.padEnd(width)}  ${cells}${over}`);
}

// The output is the point of the two scenarios that have any: silence when
// idle, one notice when there is work.
for (const label of ["idle", "work (spawns"]) {
  const run = results.find((r) => r.label.startsWith(label));
  console.log(`\n${label} stdout: ${JSON.stringify(run?.stdout.trim() ?? "")}`);
}
