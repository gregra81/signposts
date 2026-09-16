// Behaviour test for R2: an unknown or missing subcommand prints usage to
// stderr and exits 1, without touching the filesystem or any port.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig, type ResolvedConfig } from "../../../src/core/config/resolve.js";
import { runCli } from "../helpers/run-cli.js";
import { createFakeStdio } from "../helpers/fake-stdio.js";

describe("unknown/missing subcommand", () => {
  let homeDir: string;
  let repoRoot: string;
  let config: ResolvedConfig;

  beforeEach(() => {
    homeDir = mkdtempSync(path.join(tmpdir(), "signposts-dispatch-home-"));
    repoRoot = mkdtempSync(path.join(tmpdir(), "signposts-dispatch-repo-"));
    config = resolveConfig({ repoRoot, homeDir, env: {} });
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("an unrecognised subcommand prints usage to stderr and exits 1", async () => {
    const stdio = createFakeStdio();
    const exitCode = await runCli(["bogus"], {
      config,
     
      stdio,
    });

    expect(exitCode).toBe(1);
    expect(stdio.writtenError()).toContain("usage");
    expect(stdio.writtenOutput()).toBe("");
  });

  it("--help prints usage, naming every flag, to stdout and exits 0", async () => {
    const stdio = createFakeStdio();
    const exitCode = await runCli(["--help"], { config, stdio });

    expect(exitCode).toBe(0);
    const help = stdio.writtenOutput();
    for (const flag of ["--session", "--content-hash", "--replies", "--first", "--verbose", "--help", "--version"]) {
      expect(help).toContain(flag);
    }
    for (const command of ["init", "index", "doctor", "sessions", "run", "resume", "review"]) {
      expect(help).toContain(command);
    }
    expect(stdio.writtenError()).toBe("");
  });

  it("--version prints the version it was built with and exits 0", async () => {
    const stdio = createFakeStdio();
    const exitCode = await runCli(["--version"], { config, stdio, version: "9.9.9" });

    expect(exitCode).toBe(0);
    expect(stdio.writtenOutput()).toBe("9.9.9\n");
  });

  it("no subcommand at all prints usage to stderr and exits 1", async () => {
    const stdio = createFakeStdio();
    const exitCode = await runCli([], { config, stdio });

    expect(exitCode).toBe(1);
    expect(stdio.writtenError()).toContain("usage");
  });
});
