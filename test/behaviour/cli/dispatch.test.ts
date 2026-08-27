// Behaviour test for R2: an unknown or missing subcommand prints usage to
// stderr and exits 1, without touching the filesystem or any port.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig, type ResolvedConfig } from "../../../src/core/config/resolve.js";
import { runCli } from "../helpers/run-cli.js";
import { createFakeStdio } from "../helpers/fake-stdio.js";
import { fakePorts, NO_CREDENTIALS } from "../helpers/fake-ports.js";

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
      ports: fakePorts(),
      credentials: NO_CREDENTIALS,
      stdio,
    });

    expect(exitCode).toBe(1);
    expect(stdio.writtenError()).toContain("usage");
    expect(stdio.writtenOutput()).toBe("");
  });

  it("no subcommand at all prints usage to stderr and exits 1", async () => {
    const stdio = createFakeStdio();
    const exitCode = await runCli([], { config, ports: fakePorts(), credentials: NO_CREDENTIALS, stdio });

    expect(exitCode).toBe(1);
    expect(stdio.writtenError()).toContain("usage");
  });
});
