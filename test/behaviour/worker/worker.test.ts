// `signpost worker` at the CLI seam: real fs, real SQLite, real embedder.
//
// What is being proved here is mostly what the worker does NOT do. It is
// spawned detached by the SessionStart hook, with no session behind it, so it
// cannot answer a model call — and the failure mode that matters is a worker
// that starts a run anyway, halts on the first `extract`, and leaves a lock
// and a half-finished thread behind it.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig, type ResolvedConfig } from "../../../src/core/config/resolve.js";
import { serialiseSignpost } from "../../../src/core/signpost/codec.js";
import type { Signpost } from "../../../src/core/signpost/schema.js";
import type { WorkerStatus } from "../../../src/core/worker/status.js";
import { openDb } from "../../../src/io/db/migrate.js";
import { runCli } from "../helpers/run-cli.js";
import { createFakeStdio } from "../helpers/fake-stdio.js";
import { testLocalModelPath, testModelCache } from "../../support/model-cache.js";

const modelCacheRoot = testModelCache();

function signpost(id: string, claim: string): Signpost {
  return {
    id,
    claim,
    category: "gotcha",
    scope: { repo: "acme/platform" },
    evidence: "Observed once in a session.",
    confidence: 0.9,
    provenance: {
      session_ids: ["session-1"],
      authors: ["author-abcd"],
      first_seen: "2026-01-01T00:00:00.000Z",
      last_reinforced: "2026-01-01T00:00:00.000Z",
    },
    status: "active",
  };
}

describe("signpost worker", () => {
  let homeDir: string;
  let repoRoot: string;
  let config: ResolvedConfig;

  beforeEach(() => {
    homeDir = mkdtempSync(path.join(tmpdir(), "signposts-worker-home-"));
    repoRoot = mkdtempSync(path.join(tmpdir(), "signposts-worker-repo-"));
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:test/repo.git"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.email", "dev@acme.example"], { cwd: repoRoot });

    const base = resolveConfig({ repoRoot, homeDir, env: {} });
    config = {
      ...base,
      paths: { ...base.paths, modelCacheDir: modelCacheRoot },
      retrieval: {
        ...base.retrieval,
        allow_remote_models: false,
        local_model_path: testLocalModelPath(),
      },
    };
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function writeSignpostFile(s: Signpost): void {
    mkdirSync(config.paths.knowledgeDir, { recursive: true });
    writeFileSync(path.join(config.paths.knowledgeDir, `${s.id}.md`), serialiseSignpost(s), "utf8");
  }

  function status(): WorkerStatus {
    return JSON.parse(readFileSync(config.paths.statuslineState, "utf8")) as WorkerStatus;
  }

  const worker = (argv: string[] = ["worker"]) =>
    runCli(argv, { config, stdio: createFakeStdio() });

  it(
    "builds the index a cold clone arrived without, with no credential configured",
    async () => {
      writeSignpostFile(signpost("staging-read-only", "Staging is read only outside the ETL window"));
      expect(existsSync(config.paths.dbPath)).toBe(false);

      expect(await worker()).toBe(0);

      const db = openDb(config.paths.dbPath);
      try {
        const rows = db.prepare("SELECT id FROM signposts WHERE repo = ?").all("test/repo");
        expect(rows).toEqual([{ id: "staging-read-only" }]);
      } finally {
        db.close();
      }
      expect(status().lastIndexedAt).toBeTypeOf("string");
    },
    120_000,
  );

  it(
    "writes the census the hook reads, and releases the lock",
    async () => {
      writeSignpostFile(signpost("a-claim", "Something true about the system"));

      expect(await worker()).toBe(0);

      const written = status();
      expect(written.phase).toBe("idle");
      expect(written.eligibleSessions).toBe(0);
      expect(written.threadsWaiting).toBe(0);
      expect(written.lastError).toBeUndefined();
      // Held for the duration and no longer: a lock left behind silences every
      // future session start for LOCK_STALE_MINUTES.
      expect(existsSync(config.paths.lockfile)).toBe(false);
    },
    120_000,
  );

  // The whole reason the worker takes a census instead of doing the work.
  it(
    "never writes the session watermark, so a backlog keeps waking the hook",
    async () => {
      writeSignpostFile(signpost("a-claim", "Something true about the system"));
      await worker();

      expect(status()).not.toHaveProperty("lastRunFinishedAt");
    },
    120_000,
  );

  it(
    "does nothing while another worker holds a fresh lock",
    async () => {
      writeSignpostFile(signpost("a-claim", "Something true about the system"));
      mkdirSync(config.paths.stateDir, { recursive: true });
      writeFileSync(config.paths.lockfile, JSON.stringify({ pid: 1 }));

      expect(await worker()).toBe(0);
      // No index built, no status written: it saw the lock and stopped.
      expect(existsSync(config.paths.dbPath)).toBe(false);
      expect(existsSync(config.paths.statuslineState)).toBe(false);
      // And it left the other worker's lock exactly where it was.
      expect(JSON.parse(readFileSync(config.paths.lockfile, "utf8")).pid).toBe(1);
    },
    120_000,
  );

  it(
    "adopts the lock the hook took, rather than treating it as a rival",
    async () => {
      writeSignpostFile(signpost("a-claim", "Something true about the system"));
      mkdirSync(config.paths.stateDir, { recursive: true });
      writeFileSync(config.paths.lockfile, JSON.stringify({ pid: 1, startedAt: "now" }));

      expect(await worker(["worker", "--adopt-lock"])).toBe(0);

      expect(existsSync(config.paths.dbPath)).toBe(true);
      expect(existsSync(config.paths.lockfile)).toBe(false);
    },
    120_000,
  );

  // A background process must never leave the lock behind on the way out.
  it(
    "records the reason and releases the lock when the repo has no origin",
    async () => {
      execFileSync("git", ["remote", "remove", "origin"], { cwd: repoRoot });
      writeSignpostFile(signpost("a-claim", "Something true about the system"));

      expect(await worker()).toBe(0);

      expect(status().lastError).toMatch(/origin/);
      expect(existsSync(config.paths.lockfile)).toBe(false);
    },
    120_000,
  );
});
