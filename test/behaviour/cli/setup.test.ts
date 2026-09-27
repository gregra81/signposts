// Setup on first use (19-value-to-a-user.md, "Fewer human steps"): the first
// `sessions`, `run` or `resume` in a repo sets it up, so nobody types `init`.
//
// Replaces the consent-gate tests that stood here, which asserted the
// opposite: that those commands refused until `init` had asked. The yes to
// the session's offer is the consent now.
//
// `openRun` is a counter rather than the production seam: what matters is
// that setup happens before the run opens, and that it writes only local
// files — nothing into the checkout the team shares.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig, type ResolvedConfig } from "../../../src/core/config/resolve.js";
import type { OpenRun, RunHandle } from "../../../src/cli/run-port.js";
import { openDb } from "../../../src/io/db/migrate.js";
import { hasConsented } from "../../../src/io/db/repo-state.js";
import { runCli } from "../helpers/run-cli.js";
import { createFakeStdio } from "../helpers/fake-stdio.js";
import { testLocalModelPath, testModelCache } from "../../support/model-cache.js";

describe("the first skill command sets the repo up", () => {
  let repoRoot: string;
  let config: ResolvedConfig;
  let opened: number;

  /** A run seam that records having been opened, and lists nothing to do. */
  const openRun: OpenRun = () => {
    opened += 1;
    return Promise.resolve({
      handle: {
        repo: "acme/api",
        eligible: () => [],
        close: () => {},
      } as unknown as RunHandle,
    });
  };

  const setUp = (): boolean => {
    if (!existsSync(config.paths.dbPath)) {
      return false;
    }
    const db = openDb(config.paths.dbPath);
    try {
      return hasConsented(db, "acme/api");
    } finally {
      db.close();
    }
  };

  const localSettings = (): { permissions?: { allow?: string[] } } =>
    JSON.parse(readFileSync(path.join(repoRoot, ".claude", "settings.local.json"), "utf8")) as {
      permissions?: { allow?: string[] };
    };

  beforeEach(() => {
    repoRoot = mkdtempSync(path.join(tmpdir(), "signposts-setup-"));
    opened = 0;
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/api.git"], { cwd: repoRoot });
    // A repo-level excludesFile shadows the developer's global one, which
    // Claude Code may already have taught to ignore settings.local.json.
    execFileSync("git", ["config", "core.excludesFile", "/dev/null"], { cwd: repoRoot });
    config = resolveConfig({
      repoRoot,
      homeDir: repoRoot,
      repoFileContents: undefined,
      userFileContents: undefined,
      env: {
        SIGNPOSTS_RETRIEVAL_ALLOW_REMOTE_MODELS: "false",
        SIGNPOSTS_RETRIEVAL_LOCAL_MODEL_PATH: testLocalModelPath(),
      },
    });
    config = { ...config, paths: { ...config.paths, modelCacheDir: testModelCache() } };
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it.each(["sessions", "run", "resume"])("%s sets the repo up, then carries on", async (command) => {
    const stdio = createFakeStdio();

    await runCli([command], { config, openRun, stdio });

    expect(setUp()).toBe(true);
    expect(opened).toBe(1);
  });

  it("allows the loop's two tools, so a run does not stop to ask", async () => {
    await runCli(["sessions"], { config, openRun, stdio: createFakeStdio() });

    expect(localSettings().permissions?.allow).toEqual([
      "Bash(signpost *)",
      `Edit(/${config.paths.repliesPath})`,
    ]);
  });

  it("keeps stdout one JSON object: what setup says goes to stderr", async () => {
    const stdio = createFakeStdio();

    await runCli(["sessions"], { config, openRun, stdio });

    expect(JSON.parse(stdio.writtenOutput())).toEqual({ sessions: [] });
    expect(stdio.writtenError()).toContain("signposts: allowed Bash(signpost *)");
  });

  it("writes nothing into the checkout but the settings file git now ignores", async () => {
    await runCli(["run"], { config, openRun, stdio: createFakeStdio() });

    const untracked = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    // The state directory lives under homeDir, which this test puts inside
    // the repo; everything else would be a file the developer has to deal with.
    const inCheckout = untracked
      .split("\n")
      .filter((line) => line !== "" && !line.includes(".signposts/"))
      .filter((line) => !line.startsWith("?? .signposts"));
    expect(inCheckout).toEqual([]);
    expect(existsSync(path.join(repoRoot, "CLAUDE.md"))).toBe(false);
    expect(existsSync(path.join(repoRoot, ".claude", "skills"))).toBe(false);
  });

  // `init` fetched the embedding model so its download never lands inside a
  // Claude turn. Nobody runs `init` now, so setup does it instead — once.
  it("fetches the model when it sets the repo up, and not again", async () => {
    let fetched = 0;
    const prefetchModel = (_config: ResolvedConfig, say: (line: string) => void): Promise<void> => {
      fetched += 1;
      say("model fetched");
      return Promise.resolve();
    };
    const first = createFakeStdio();

    await runCli(["sessions"], { config, openRun, stdio: first, prefetchModel });
    await runCli(["run"], { config, openRun, stdio: createFakeStdio(), prefetchModel });

    expect(fetched).toBe(1);
    expect(first.writtenError()).toContain("signposts: model fetched\n");
    expect(JSON.parse(first.writtenOutput())).toEqual({ sessions: [] });
  });

  it("does it once: a second command says nothing about setup", async () => {
    await runCli(["run"], { config, openRun, stdio: createFakeStdio() });
    const second = createFakeStdio();

    await runCli(["run"], { config, openRun, stdio: second });

    expect(second.writtenError()).not.toContain("allowed");
    expect(opened).toBe(2);
  });

  it("leaves a reader's commands alone: index writes no setup", async () => {
    await runCli(["index"], { config, openRun, stdio: createFakeStdio() });

    expect(setUp()).toBe(false);
    expect(existsSync(path.join(repoRoot, ".claude", "settings.local.json"))).toBe(false);
  });
});
