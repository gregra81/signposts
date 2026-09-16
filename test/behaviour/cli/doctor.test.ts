// Behaviour tests for `signpost doctor` (R5, R8) at the CLI seam.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig, type ResolvedConfig } from "../../../src/core/config/resolve.js";
import { runCli } from "../helpers/run-cli.js";
import { createFakeStdio } from "../helpers/fake-stdio.js";
import { MODEL_REPO, MODEL_REVISION } from "../../support/model-cache.js";
import { cachedWeightsPath, vendoredWeightsPath } from "../../../src/core/retrieval/model-files.js";

/** A stand-in for the ONNX weights, in a directory that may not exist yet. */
function writeWeights(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "", "utf8");
}

describe("signpost doctor", () => {
  let homeDir: string;
  let repoRoot: string;
  let config: ResolvedConfig;

  beforeEach(() => {
    homeDir = mkdtempSync(path.join(tmpdir(), "signposts-doctor-home-"));
    repoRoot = mkdtempSync(path.join(tmpdir(), "signposts-doctor-repo-"));
    // Deliberately no `origin` remote here (unlike init.test.ts/index.test.ts) —
    // `doctor` must run and complete in a repo with no GitHub origin at all
    // (R5's fix), which every test in this file except the one below proves.
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
    config = resolveConfig({ repoRoot, homeDir, env: {} });
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("against an uninitialised repo: reports no database yet, hook nowhere it can see", async () => {
    const stdio = createFakeStdio();

    const exitCode = await runCli(["doctor"], {
      config,
     
      stdio,
    });

    // It still runs and reports every line with no origin at all (R5). What
    // changed is the exit code: no origin blocks `init`, `index` and `run`, and
    // a doctor that exits 0 over that tells a script everything is fine
    // (19-value-to-a-user.md item 4).
    expect(exitCode).toBe(1);
    expect(stdio.writtenOutput()).toContain("blocked: ");
    expect(stdio.writtenOutput()).toContain("no origin remote");
    const output = stdio.writtenOutput();
    expect(output).toContain("node:");
    expect(output).toContain("gh:");
    expect(output).toContain("embedding model cache:");
    expect(output).toContain("no database yet");
    expect(output).toContain("session-start hook: not found in settings or in an enabled plugin");
  });

  it("against an initialised repo: reports db ok after `init` has created it", async () => {
    // `init` (unlike `doctor`) needs a repo key, so it needs an origin remote.
    execFileSync("git", ["remote", "add", "origin", "git@github.com:test/repo.git"], { cwd: repoRoot });
    // Set here rather than inherited from whoever runs the suite: an unset
    // author now blocks, and a CI runner has none.
    execFileSync("git", ["config", "user.email", "dev@example.com"], { cwd: repoRoot });

    await runCli(["init"], {
      config,
     
      stdio: createFakeStdio("y"),
    });

    const stdio = createFakeStdio();
    const exitCode = await runCli(["doctor"], {
      config,
     
      stdio,
    });

    expect(exitCode).toBe(0);
    expect(stdio.writtenOutput()).toContain("database: ok");
    expect(stdio.writtenOutput()).toContain("consent: given");
    expect(stdio.writtenOutput()).toContain("ready: nothing blocks");
  });

  // 19-value-to-a-user.md items 4 and 6.
  describe("in a repo that could otherwise run", () => {
    beforeEach(() => {
      execFileSync("git", ["remote", "add", "origin", "git@github.com:test/repo.git"], { cwd: repoRoot });
      execFileSync("git", ["config", "user.email", "dev@example.com"], { cwd: repoRoot });
    });

    it("exits 1 when this repo has not consented, and says how to", async () => {
      const stdio = createFakeStdio();
      const exitCode = await runCli(["doctor"], { config, stdio });

      expect(exitCode).toBe(1);
      expect(stdio.writtenOutput()).toContain("consent: not given — run `signpost init`");
      expect(stdio.writtenOutput()).toContain("blocked: no consent");
    });

    it("reports the error the background worker left, which the status line sends people here for", async () => {
      await runCli(["init"], { config, stdio: createFakeStdio("y") });
      mkdirSync(config.paths.stateDir, { recursive: true });
      writeFileSync(
        config.paths.statuslineState,
        JSON.stringify({ phase: "idle", updatedAt: "2026-09-16T00:00:00.000Z", eligibleSessions: 0, threadsWaiting: 0, lastError: "index rebuild exited 1" }),
      );

      const stdio = createFakeStdio();
      const exitCode = await runCli(["doctor"], { config, stdio });

      expect(stdio.writtenOutput()).toContain("last background error: index rebuild exited 1");
      // A failed reindex degrades search; it does not stop a run.
      expect(exitCode).toBe(0);
    });

    it("names a status line whose script has gone", async () => {
      await runCli(["init"], { config, stdio: createFakeStdio("y") });
      const gone = path.join(homeDir, "uninstalled", "signposts", "statusline", "statusline.js");
      writeFileSync(
        path.join(repoRoot, ".claude", "settings.local.json"),
        JSON.stringify({ statusLine: { type: "command", command: `node '${gone}' --wrap 'git branch --show-current'` } }),
      );

      const stdio = createFakeStdio();
      await runCli(["doctor"], { config, stdio });

      expect(stdio.writtenOutput()).toContain(`status line: points at ${gone}`);
    });
  });

  it("reports a signposts SessionStart hook when one is present in .claude/settings.json", async () => {
    mkdirSync(path.join(repoRoot, ".claude"), { recursive: true });
    writeFileSync(
      path.join(repoRoot, ".claude", "settings.json"),
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node ./signpost-session-start.js" }] }] },
      }),
      "utf8",
    );

    const stdio = createFakeStdio();
    await runCli(["doctor"], { config, stdio });

    expect(stdio.writtenOutput()).toContain("session-start hook: installed");
  });

  it("reports a hook installed in settings.local.json, where a personal one goes", async () => {
    // `init` writes the status line to settings.local.json for the same
    // reason a hook command holding an absolute path belongs there — reading
    // only the shared file told a developer their own installed hook was
    // missing.
    mkdirSync(path.join(repoRoot, ".claude"), { recursive: true });
    writeFileSync(
      path.join(repoRoot, ".claude", "settings.local.json"),
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node /opt/signposts/hooks/session-start.js" }] }] },
      }),
      "utf8",
    );

    const stdio = createFakeStdio();
    await runCli(["doctor"], { config, stdio });

    expect(stdio.writtenOutput()).toContain("session-start hook: installed");
  });

  it("reports a hook installed once globally, in ~/.claude/settings.json", async () => {
    // A hook command holds an absolute path to this machine's install, so the
    // user-level file is where one is most likely to be — and a repo-only
    // check called it missing while it fired on every session start.
    const claudeConfigRoot = path.dirname(config.paths.transcriptRoot);
    mkdirSync(claudeConfigRoot, { recursive: true });
    writeFileSync(
      path.join(claudeConfigRoot, "settings.json"),
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node /opt/signposts/hooks/session-start.js" }] }] },
      }),
      "utf8",
    );

    const stdio = createFakeStdio();
    await runCli(["doctor"], { config, stdio });

    expect(stdio.writtenOutput()).toContain("session-start hook: installed");
  });

  it("an empty cache directory is cold, not present", async () => {
    // The directory alone is what the old check looked at, and the first
    // embedder that ever ran creates it — so an interrupted download reported
    // a cache that could not load a model.
    mkdirSync(config.paths.modelCacheDir, { recursive: true });

    const stdio = createFakeStdio();
    await runCli(["doctor"], { config, stdio });

    expect(stdio.writtenOutput()).toContain("embedding model cache: cold");
  });

  it("the pinned revision's weights in the cache are warm", async () => {
    writeWeights(cachedWeightsPath(config.paths.modelCacheDir, MODEL_REPO, MODEL_REVISION));

    const stdio = createFakeStdio();
    await runCli(["doctor"], { config, stdio });

    expect(stdio.writtenOutput()).toContain("embedding model cache: warm");
  });

  it("a download interrupted before the weights landed is still cold", async () => {
    // transformers.js renames one completed file at a time into the revision
    // directory, so config.json and tokenizer.json arrive before the ONNX
    // weights do. The directory is populated and nothing can load from it.
    const revisionDir = path.join(config.paths.modelCacheDir, MODEL_REPO, MODEL_REVISION);
    mkdirSync(path.join(revisionDir, "onnx"), { recursive: true });
    writeFileSync(path.join(revisionDir, "config.json"), "{}", "utf8");
    writeFileSync(path.join(revisionDir, "tokenizer.json"), "{}", "utf8");

    const stdio = createFakeStdio();
    await runCli(["doctor"], { config, stdio });

    expect(stdio.writtenOutput()).toContain("embedding model cache: cold");
  });

  it("an empty cache with no route to the model host is unavailable, not cold", async () => {
    // 15-spec.md story 57's restricted network, minus the vendored copy:
    // transformers.js throws instead of downloading, so "cold — the first run
    // downloads the model" would be a promise nothing can keep.
    const offline = resolveConfig({
      repoRoot,
      homeDir,
      env: { SIGNPOSTS_RETRIEVAL_ALLOW_REMOTE_MODELS: "false" },
    });

    const stdio = createFakeStdio();
    await runCli(["doctor"], { config: offline, stdio });

    expect(stdio.writtenOutput()).toContain("embedding model cache: unavailable");
  });

  it("a vendored model is reported as such, cold shared cache and all", async () => {
    // 15-spec.md story 57: a restricted network points retrieval at a local
    // copy, which transformers.js resolves flat and without the revision.
    const vendored = path.join(repoRoot, "vendor", "models");
    writeWeights(vendoredWeightsPath(vendored, MODEL_REPO));
    const vendoredConfig = resolveConfig({
      repoRoot,
      homeDir,
      env: { SIGNPOSTS_RETRIEVAL_LOCAL_MODEL_PATH: vendored },
    });

    const stdio = createFakeStdio();
    await runCli(["doctor"], { config: vendoredConfig, stdio });

    expect(stdio.writtenOutput()).toContain("embedding model cache: vendored");
  });
});
