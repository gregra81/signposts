import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRepoConfigFile, readUserConfigFile } from "../../../src/io/config.js";

describe("readRepoConfigFile / readUserConfigFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "signposts-io-config-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns undefined when the repo config file doesn't exist", () => {
    expect(readRepoConfigFile(dir)).toBeUndefined();
  });

  it("returns undefined when the user config file doesn't exist", () => {
    expect(readUserConfigFile(dir)).toBeUndefined();
  });

  it("reads .signposts/config.yaml under the repo root", () => {
    mkdirSync(path.join(dir, ".signposts"), { recursive: true });
    writeFileSync(path.join(dir, ".signposts", "config.yaml"), "retrieval:\n  k: 9\n");

    expect(readRepoConfigFile(dir)).toBe("retrieval:\n  k: 9\n");
  });

  it("reads .signposts/config.yaml under the home directory", () => {
    mkdirSync(path.join(dir, ".signposts"), { recursive: true });
    writeFileSync(path.join(dir, ".signposts", "config.yaml"), "retrieval:\n  k: 11\n");

    expect(readUserConfigFile(dir)).toBe("retrieval:\n  k: 11\n");
  });
});
