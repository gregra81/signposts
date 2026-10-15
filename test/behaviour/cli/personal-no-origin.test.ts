// Personal storage in a repo with no `owner/name` origin. The repo route needs
// the remote for its branch and pull request; personal storage has neither, so
// it keys the repo locally rather than refusing to run.

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../../../src/core/config/resolve.js";
import { STORAGE_PERSONAL, STORAGE_REPO } from "../../../src/core/config/constants.js";
import { localRepoKey } from "../../../src/core/git/owner-repo.js";
import { resolveRepo } from "../../../src/io/git/remote-origin.js";
import { runCli } from "../helpers/run-cli.js";
import { createFakeStdio } from "../helpers/fake-stdio.js";
import { testLocalModelPath, testModelCache } from "../../support/model-cache.js";

describe("a repo with no origin", () => {
  let homeDir: string;
  let repoRoot: string;

  beforeEach(() => {
    homeDir = mkdtempSync(path.join(tmpdir(), "signposts-no-origin-home-"));
    repoRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "signposts-no-origin-repo-")));
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("is keyed by its directory name under personal storage", () => {
    expect(localRepoKey(repoRoot)).toBe(`local/${path.basename(repoRoot)}`);
    expect(resolveRepo(repoRoot, STORAGE_PERSONAL)).toBe(localRepoKey(repoRoot));
  });

  it("still has no key on the repo route, which needs the remote for its pull request", () => {
    expect(resolveRepo(repoRoot, STORAGE_REPO)).toBeNull();
    expect(resolveRepo(repoRoot)).toBeNull();
  });

  it("keeps the origin's key under personal storage when there is one", () => {
    execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/api.git"], { cwd: repoRoot });

    expect(resolveRepo(repoRoot, STORAGE_PERSONAL)).toBe("acme/api");
  });

  it(
    "lets `signpost index` run under personal storage",
    async () => {
      const resolved = resolveConfig({ repoRoot, homeDir, env: { SIGNPOSTS_STORAGE: STORAGE_PERSONAL } });
      const config = {
        ...resolved,
        paths: { ...resolved.paths, modelCacheDir: testModelCache() },
        retrieval: { ...resolved.retrieval, allow_remote_models: false, local_model_path: testLocalModelPath() },
      };
      const stdio = createFakeStdio();

      const exitCode = await runCli(["index"], { config, stdio });

      expect(stdio.writtenError()).not.toContain("origin");
      expect(exitCode).toBe(0);
    },
    120_000,
  );
});
