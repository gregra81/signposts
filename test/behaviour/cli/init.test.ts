// Behaviour tests for `signpost init` (R3, R8) at the CLI seam: real fs,
// real SQLite, a temp $HOME and a temp git repo, driven through runCli.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig, type ResolvedConfig } from "../../../src/core/config/resolve.js";
import { CLAUDE_MD_POINTER } from "../../../src/core/init/policy.js";
import { deriveOwnerRepo } from "../../../src/core/git/owner-repo.js";
import { getOriginUrl } from "../../../src/io/git/remote-origin.js";
import { openDb } from "../../../src/io/db/migrate.js";
import { hasConsented } from "../../../src/io/db/repo-state.js";
import { runCli } from "../helpers/run-cli.js";
import { createEofStdio, createFakeStdio } from "../helpers/fake-stdio.js";

describe("signpost init", () => {
  let homeDir: string;
  let repoRoot: string;
  let config: ResolvedConfig;
  let repo: string;

  beforeEach(() => {
    homeDir = mkdtempSync(path.join(tmpdir(), "signposts-init-home-"));
    repoRoot = mkdtempSync(path.join(tmpdir(), "signposts-init-repo-"));
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:test/repo.git"], { cwd: repoRoot });
    const originUrl = getOriginUrl(repoRoot);
    repo = (originUrl !== null ? deriveOwnerRepo(originUrl) : null) ?? "test/repo";
    config = resolveConfig({ repoRoot, homeDir, env: {} });
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("fresh init: creates .signposts/, appends the CLAUDE.md pointer, persists consent on accept", async () => {
    const stdio = createFakeStdio("y");

    const exitCode = await runCli(["init"], { config, stdio });

    expect(exitCode).toBe(0);
    expect(existsSync(config.paths.knowledgeDir)).toBe(true);
    expect(readFileSync(path.join(repoRoot, "CLAUDE.md"), "utf8")).toBe(CLAUDE_MD_POINTER);

    const db = openDb(config.paths.dbPath);
    try {
      expect(hasConsented(db, repo)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("re-running init on an already-consented repo is a no-op reporting already-initialised", async () => {
    await runCli(["init"], {
      config,
     
      stdio: createFakeStdio("y"),
    });

    const secondStdio = createFakeStdio();
    const exitCode = await runCli(["init"], {
      config,
     
      stdio: secondStdio,
    });

    expect(exitCode).toBe(0);
    expect(secondStdio.writtenOutput()).toContain("already initialised");
  });

  it("declining consent exits 1 and persists no state", async () => {
    const stdio = createFakeStdio("n");

    const exitCode = await runCli(["init"], { config, stdio });

    expect(exitCode).toBe(1);
    expect(existsSync(config.paths.knowledgeDir)).toBe(false);
    expect(existsSync(path.join(repoRoot, "CLAUDE.md"))).toBe(false);
    // Assert before opening the db — openDb() creates/migrates the file, so
    // opening it here first would make this assertion vacuous.
    expect(existsSync(config.paths.dbPath)).toBe(false);
  });

  it("empty stdin (EOF, non-interactive) is treated as decline, not a hang", async () => {
    const stdio = createEofStdio();

    const exitCode = await runCli(["init"], { config, stdio });

    expect(exitCode).toBe(1);
    expect(existsSync(config.paths.dbPath)).toBe(false);
  });

  it("running init twice, accepting both times, is idempotent — the CLAUDE.md pointer is written once", async () => {
    await runCli(["init"], {
      config,
     
      stdio: createFakeStdio("y"),
    });
    const exitCode = await runCli(["init"], {
      config,
     
      stdio: createFakeStdio("y"),
    });

    expect(exitCode).toBe(0);
    const content = readFileSync(path.join(repoRoot, "CLAUDE.md"), "utf8");
    expect(content).toBe(CLAUDE_MD_POINTER);
  });
});
