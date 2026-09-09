// The consent gate (15-spec.md story 70, R3): what a repo that has never
// been asked is allowed to do.
//
// The point of these is that the gate holds on the manual path, not only
// through `init`. A developer who has read the README and typed
// `signpost run` has been through no prompt at all, and that is exactly the
// person unexplained spend would surprise.
//
// `openRun` is a counter here rather than the production seam: what is being
// asserted is that the refusal happens *before* a run is opened — before the
// database, the checkpointer and the embedder exist — so a repo that says no
// is left with nothing.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig, type ResolvedConfig } from "../../../src/core/config/resolve.js";
import type { OpenRun, RunHandle } from "../../../src/cli/run-port.js";
import { runCli } from "../helpers/run-cli.js";
import { createFakeStdio } from "../helpers/fake-stdio.js";
import { giveConsent } from "../helpers/consent.js";
import { testLocalModelPath, testModelCache } from "../../support/model-cache.js";

describe("consent gates what spends tokens", () => {
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
        pendingReviews: () => Promise.resolve([]),
        close: () => {},
      } as unknown as RunHandle,
    });
  };

  beforeEach(() => {
    repoRoot = mkdtempSync(path.join(tmpdir(), "signposts-consent-"));
    opened = 0;
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/api.git"], { cwd: repoRoot });
    config = resolveConfig({
      repoRoot,
      homeDir: repoRoot,
      repoFileContents: undefined,
      userFileContents: undefined,
      // `index` builds a real embedder, and the suite runs with the network
      // denied — so it reads the model the global setup put on disk.
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

  it.each(["run", "resume", "review"])("%s refuses before opening anything, and says how to consent", async (command) => {
    const stdio = createFakeStdio();

    const exitCode = await runCli([command], { config, openRun, stdio });

    expect(exitCode).toBe(1);
    expect(stdio.writtenError()).toContain("signpost init");
    expect(opened).toBe(0);
  });

  it.each(["sessions", "index"])("%s runs unasked — it is local and free", async (command) => {
    const stdio = createFakeStdio();

    await runCli([command], { config, openRun, stdio });

    // `index` does not go through `openRun`; what matters is that neither was
    // refused for want of consent.
    expect(stdio.writtenError()).not.toContain("signpost init");
  });

  it("lets a consented repo through to the run", async () => {
    giveConsent(config, repoRoot);
    const stdio = createFakeStdio();

    await runCli(["run"], { config, openRun, stdio });

    expect(opened).toBe(1);
  });

  it("is asked once and stays answered — a second command never re-asks", async () => {
    giveConsent(config, repoRoot);

    await runCli(["run"], { config, openRun, stdio: createFakeStdio() });
    const second = createFakeStdio();
    await runCli(["run"], { config, openRun, stdio: second });

    expect(second.writtenOutput()).not.toContain("Continue?");
    expect(opened).toBe(2);
  });
});
