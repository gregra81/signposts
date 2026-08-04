import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { derivePaths, hashRepoRoot } from "../../../src/core/config/paths.js";

describe("hashRepoRoot", () => {
  it("is stable for the same repoRoot", () => {
    expect(hashRepoRoot("/Users/greg/Projects/signposts")).toBe(
      hashRepoRoot("/Users/greg/Projects/signposts"),
    );
  });

  it("diverges for a different repoRoot", () => {
    expect(hashRepoRoot("/Users/greg/Projects/signposts")).not.toBe(
      hashRepoRoot("/Users/greg/Projects/other-repo"),
    );
  });

  it("is exactly 12 hex characters", () => {
    const hash = hashRepoRoot("/anything");
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it("is sha256(repoRoot).slice(0, 12), with repoRoot taken exactly as given", () => {
    const repoRoot = "/repo/alpha";
    const expected = createHash("sha256").update(repoRoot).digest("hex").slice(0, 12);
    expect(hashRepoRoot(repoRoot)).toBe(expected);
  });

  it("does not normalise repoRoot — a trailing slash changes the hash", () => {
    expect(hashRepoRoot("/repo/alpha")).not.toBe(hashRepoRoot("/repo/alpha/"));
  });
});

describe("derivePaths", () => {
  const repoRoot = "/Users/greg/Projects/signposts";
  const homeDir = "/Users/greg";

  it("keys STATE_DIR by the repo hash under ~/.signposts/", () => {
    const paths = derivePaths(repoRoot, homeDir);
    expect(paths.stateDir).toBe(`${homeDir}/.signposts/${paths.repoHash}`);
  });

  it("derives the four state files under STATE_DIR", () => {
    const paths = derivePaths(repoRoot, homeDir);
    expect(paths.dbPath).toBe(`${paths.stateDir}/signposts.db`);
    expect(paths.checkpointPath).toBe(`${paths.stateDir}/checkpoints.db`);
    expect(paths.statuslineState).toBe(`${paths.stateDir}/status.json`);
    expect(paths.lockfile).toBe(`${paths.stateDir}/run.lock`);
  });

  it("puts MODEL_CACHE_DIR beside the per-repo state dirs, not under any one of them", () => {
    const paths = derivePaths(repoRoot, homeDir);
    expect(paths.modelCacheDir).toBe(`${homeDir}/.signposts/models`);
    expect(paths.modelCacheDir.startsWith(paths.stateDir)).toBe(false);
  });

  it("is global: the same for two different repos", () => {
    const a = derivePaths(repoRoot, homeDir);
    const b = derivePaths("/Users/greg/Projects/other-repo", homeDir);
    expect(a.modelCacheDir).toBe(b.modelCacheDir);
    expect(a.stateDir).not.toBe(b.stateDir);
  });

  it("derives KNOWLEDGE_DIR and INDEX_FILE under repoRoot, not under home", () => {
    const paths = derivePaths(repoRoot, homeDir);
    expect(paths.knowledgeDir).toBe(`${repoRoot}/.signposts`);
    expect(paths.indexFile).toBe(`${repoRoot}/.signposts/index.md`);
  });

  it("gives the same paths for the same repoRoot and different paths for a different one", () => {
    const a = derivePaths(repoRoot, homeDir);
    const b = derivePaths(repoRoot, homeDir);
    const c = derivePaths("/Users/greg/Projects/other-repo", homeDir);
    expect(a).toEqual(b);
    expect(a.stateDir).not.toBe(c.stateDir);
    expect(a.knowledgeDir).not.toBe(c.knowledgeDir);
  });
});
