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

    expect(exitCode).toBe(0);
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
