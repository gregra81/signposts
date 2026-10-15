// `signpost init --personal` and `--repo`: where one checkout's signposts are
// kept, chosen per checkout and recorded in its state directory.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig, type ResolvedConfig } from "../../../src/core/config/resolve.js";
import { readCheckoutConfigFile } from "../../../src/io/config.js";
import { runCli } from "../helpers/run-cli.js";
import { createFakeStdio } from "../helpers/fake-stdio.js";

// `init` installs the compiled statusLine and refuses to when it is absent.
const PACKAGE_ROOT = path.dirname(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))));

beforeAll(() => {
  execFileSync(process.execPath, [path.join(PACKAGE_ROOT, "scripts", "build-hooks.mjs")], { stdio: "pipe" });
});

describe("signpost init — storage", () => {
  let homeDir: string;
  let repoRoot: string;

  /** The config as the next command would resolve it, reading the checkout's file. */
  function resolved(): ResolvedConfig {
    return resolveConfig({ repoRoot, homeDir, env: {}, checkoutFileContents: readCheckoutConfigFile(repoRoot, homeDir) });
  }

  async function init(...flags: string[]): Promise<{ exitCode: number; output: string; error: string }> {
    const stdio = createFakeStdio();
    const exitCode = await runCli(["init", ...flags], { config: resolved(), stdio });
    return { exitCode, output: stdio.writtenOutput(), error: stdio.writtenError() };
  }

  beforeEach(() => {
    homeDir = mkdtempSync(path.join(tmpdir(), "signposts-init-storage-home-"));
    repoRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "signposts-init-storage-repo-")));
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("--personal records the choice for this checkout and says where the signposts go", async () => {
    execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/api.git"], { cwd: repoRoot });

    const { exitCode, output } = await init("--personal");

    expect(exitCode).toBe(0);
    const config = resolved();
    expect(readFileSync(config.paths.checkoutConfigFile, "utf8")).toBe("storage: personal\n");
    expect(config.storage).toBe("personal");
    expect(output).toContain(`keep it on this machine, in ${config.paths.knowledgeDir}`);
    expect(existsSync(path.join(homeDir, ".signposts", "config.yaml"))).toBe(false);
  });

  it("--personal needs no origin", async () => {
    const { exitCode, error } = await init("--personal");

    expect(error).toBe("");
    expect(exitCode).toBe(0);
  });

  it("--repo puts a personal checkout back on the pull request", async () => {
    execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/api.git"], { cwd: repoRoot });
    await init("--personal");

    const { exitCode, output } = await init("--repo");

    expect(exitCode).toBe(0);
    expect(resolved().storage).toBe("repo");
    expect(output).toContain("open a pull request");
  });

  it("leaves the choice alone without either flag", async () => {
    await init("--personal");

    await init();

    expect(resolved().storage).toBe("personal");
  });

  it("is per checkout: another repo on the machine stays on the pull request", async () => {
    await init("--personal");
    const other = realpathSync(mkdtempSync(path.join(tmpdir(), "signposts-init-storage-other-")));
    try {
      const config = resolveConfig({
        repoRoot: other,
        homeDir,
        env: {},
        checkoutFileContents: readCheckoutConfigFile(other, homeDir),
      });
      expect(config.storage).toBe("repo");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("names --personal when a repo with no origin cannot be set up for a pull request", async () => {
    const { exitCode, error } = await init();

    expect(exitCode).toBe(1);
    expect(error).toContain("signpost init --personal");
  });
});
