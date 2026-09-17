// src/io/embed/prefetch.ts in the two states it can reach with the network
// denied. The third, a cold cache with remote models allowed, is a real
// download and is not exercised here: the suite runs offline.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig, type ResolvedConfig } from "../../../src/core/config/resolve.js";
import { prefetchModel } from "../../../src/io/embed/prefetch.js";
import { testLocalModelPath, testModelCache } from "../../support/model-cache.js";

describe("prefetchModel", () => {
  let homeDir: string;
  let config: ResolvedConfig;
  const said: string[] = [];

  beforeEach(() => {
    said.length = 0;
    homeDir = mkdtempSync(path.join(tmpdir(), "signposts-prefetch-home-"));
    config = resolveConfig({ repoRoot: homeDir, homeDir, env: {} });
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("says nothing when the model is already on this machine", async () => {
    const resolved = {
      ...config,
      paths: { ...config.paths, modelCacheDir: testModelCache() },
      retrieval: { ...config.retrieval, allow_remote_models: false, local_model_path: testLocalModelPath() },
    };

    await prefetchModel(resolved, (line) => said.push(line));

    expect(said).toEqual([]);
  });

  it("says why it did not download, when remote models are off and nothing is on disk", async () => {
    const resolved = { ...config, retrieval: { ...config.retrieval, allow_remote_models: false, local_model_path: null } };

    await prefetchModel(resolved, (line) => said.push(line));

    expect(said).toHaveLength(1);
    expect(said[0]).toContain("allow_remote_models");
    expect(said[0]).toContain("keyword");
  });
});
