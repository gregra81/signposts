// Behaviour tests for `signpost init` (R3, R8) at the CLI seam: real fs,
// real SQLite, a temp $HOME and a temp git repo, driven through runCli.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig, type ResolvedConfig } from "../../../src/core/config/resolve.js";
import { CLAUDE_MD_POINTER } from "../../../src/core/init/policy.js";
import { deriveOwnerRepo } from "../../../src/core/git/owner-repo.js";
import { getOriginUrl } from "../../../src/io/git/remote-origin.js";
import { openDb } from "../../../src/io/db/migrate.js";
import { hasConsented } from "../../../src/io/db/repo-state.js";
import { installStatusLine, statuslineScriptPath } from "../../../src/io/init/statusline-file.js";
import { runCli } from "../helpers/run-cli.js";
import { createEofStdio, createFakeStdio } from "../helpers/fake-stdio.js";

// `init` installs the compiled statusLine, and refuses to when it is absent —
// so the artifact has to exist before these run, exactly as it does for a user
// who installed the package.
const PACKAGE_ROOT = path.dirname(
  path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))),
);

beforeAll(() => {
  execFileSync(process.execPath, [path.join(PACKAGE_ROOT, "scripts", "build-hooks.mjs")], {
    stdio: "pipe",
  });
});

describe("signpost init", () => {
  let homeDir: string;
  let repoRoot: string;
  let config: ResolvedConfig;
  let repo: string;

  beforeEach(() => {
    homeDir = mkdtempSync(path.join(tmpdir(), "signposts-init-home-"));
    repoRoot = mkdtempSync(path.join(tmpdir(), "signposts-init-repo-"));
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:test/repo.git"], { cwd: repoRoot });
    const originUrl = getOriginUrl(repoRoot);
    repo = (originUrl !== null ? deriveOwnerRepo(originUrl) : null) ?? "test/repo";
    config = resolveConfig({ repoRoot, homeDir, env: {} });
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("fresh init: creates .signposts/, appends the CLAUDE.md pointer, persists consent on accept", async () => {
    const stdio = createFakeStdio("y");

    const exitCode = await runCli(["init"], { config, stdio });

    expect(exitCode).toBe(0);
    expect(existsSync(config.paths.knowledgeDir)).toBe(true);
    expect(readFileSync(path.join(repoRoot, "CLAUDE.md"), "utf8")).toBe(CLAUDE_MD_POINTER);

    const db = openDb(config.paths.dbPath);
    try {
      expect(hasConsented(db, repo)).toBe(true);
    } finally {
      db.close();
    }
  });

  // 15-spec.md story 70 asks for three things before the first run — what it
  // does, roughly what it costs, where the output goes — because a prompt
  // that says only "continue?" is the README paragraph the story rejects.
  it("the prompt says what it does, what it costs and where the output goes", async () => {
    const stdio = createFakeStdio("y");

    await runCli(["init"], { config, stdio });

    const prompt = stdio.writtenOutput();
    expect(prompt).toContain("transcripts");
    expect(prompt).toContain("quota");
    expect(prompt).toContain("pull request");
    expect(prompt).toContain("asked once");
  });

  it("re-running init on an already-consented repo is a no-op reporting already-initialised", async () => {
    await runCli(["init"], {
      config,
     
      stdio: createFakeStdio("y"),
    });

    const secondStdio = createFakeStdio();
    const exitCode = await runCli(["init"], {
      config,
     
      stdio: secondStdio,
    });

    expect(exitCode).toBe(0);
    expect(secondStdio.writtenOutput()).toContain("already initialised");
  });

  // 07-triggering-and-ux.md's second visibility surface. `init` installs it,
  // and it goes in settings.local.json: the command names an absolute path on
  // this machine, and a status line is a personal preference — neither belongs
  // in a file the team shares.
  it("installs the status line, into the settings file that is not committed", async () => {
    await runCli(["init"], { config, stdio: createFakeStdio("y") });

    const settings = JSON.parse(
      readFileSync(path.join(repoRoot, ".claude", "settings.local.json"), "utf8"),
    );
    expect(settings.statusLine.type).toBe("command");
    expect(settings.statusLine.command).toContain("statusline/statusline.js");
    expect(existsSync(path.join(repoRoot, ".claude", "settings.json"))).toBe(false);
  });

  // The status line is somewhere the developer may already live. Claude Code
  // allows one command, so ours has to run theirs rather than replace it.
  it("wraps a status line that was already configured, and keeps its other fields", async () => {
    mkdirSync(path.join(repoRoot, ".claude"), { recursive: true });
    writeFileSync(
      path.join(repoRoot, ".claude", "settings.local.json"),
      JSON.stringify({
        statusLine: { type: "command", command: "~/bin/mystatus.sh", padding: 2 },
        permissions: { allow: ["Bash"] },
      }),
    );
    const stdio = createFakeStdio("y");

    await runCli(["init"], { config, stdio });

    const settings = JSON.parse(
      readFileSync(path.join(repoRoot, ".claude", "settings.local.json"), "utf8"),
    );
    expect(settings.statusLine.command).toBe(
      `node '${statuslineScriptPath()}' --wrap '~/bin/mystatus.sh'`,
    );
    expect(settings.statusLine.padding).toBe(2);
    expect(settings.permissions).toEqual({ allow: ["Bash"] });
    // Said out loud: a tool that edits a settings file in silence is one the
    // developer discovers when their own status line looks different.
    expect(stdio.writtenOutput()).toContain("~/bin/mystatus.sh");
  });

  // A command that is not there exits non-zero, which blanks the bar — and
  // when it is wrapping, it takes the developer's own status line with it.
  //
  // Below the CLI, and deliberately: reaching this through `runCli` meant
  // renaming the one built bundle aside and back, and vitest runs files in
  // parallel — the statusLine's own behaviour tests spawn that same file, and
  // caught it missing about one full run in three. A path this build never
  // wrote is the same absence with nothing shared in it.
  it("changes nothing when the compiled status line is not on disk", () => {
    mkdirSync(path.join(repoRoot, ".claude"), { recursive: true });
    const settingsFile = path.join(repoRoot, ".claude", "settings.local.json");
    writeFileSync(settingsFile, JSON.stringify({ statusLine: { type: "command", command: "mine" } }));

    const installed = installStatusLine(
      repoRoot,
      path.dirname(config.paths.transcriptRoot),
      path.join(repoRoot, "no-statusline.js"),
    );

    expect(installed).toBeNull();
    expect(JSON.parse(readFileSync(settingsFile, "utf8")).statusLine.command).toBe("mine");
  });

  // Where a status line almost always is: `~/.claude/settings.json`. Project
  // local outranks user, so an unwrapped install here would take it away.
  it("wraps a status line inherited from the user's own settings", async () => {
    const userSettings = path.join(homeDir, ".claude");
    mkdirSync(userSettings, { recursive: true });
    writeFileSync(
      path.join(userSettings, "settings.json"),
      JSON.stringify({
        statusLine: { type: "command", command: "~/.claude/statusline.sh", refreshInterval: 30 },
      }),
    );

    await runCli(["init"], { config, stdio: createFakeStdio("y") });

    const settings = JSON.parse(
      readFileSync(path.join(repoRoot, ".claude", "settings.local.json"), "utf8"),
    );
    expect(settings.statusLine.command).toBe(
      `node '${statuslineScriptPath()}' --wrap '~/.claude/statusline.sh'`,
    );
    // Their own pacing comes down with it: the local entry replaces the whole
    // object, so a field left behind is a field they lose.
    expect(settings.statusLine.refreshInterval).toBe(30);
  });

  it("leaves a settings file it cannot parse exactly as it is", async () => {
    mkdirSync(path.join(repoRoot, ".claude"), { recursive: true });
    const settingsFile = path.join(repoRoot, ".claude", "settings.local.json");
    writeFileSync(settingsFile, "{ half an edit");

    const exitCode = await runCli(["init"], { config, stdio: createFakeStdio("y") });

    expect(exitCode).toBe(0);
    expect(readFileSync(settingsFile, "utf8")).toBe("{ half an edit");
  });

  it("declining consent exits 1 and persists no state", async () => {
    const stdio = createFakeStdio("n");

    const exitCode = await runCli(["init"], { config, stdio });

    expect(exitCode).toBe(1);
    expect(existsSync(config.paths.knowledgeDir)).toBe(false);
    expect(existsSync(path.join(repoRoot, "CLAUDE.md"))).toBe(false);
    // Assert before opening the db — openDb() creates/migrates the file, so
    // opening it here first would make this assertion vacuous.
    expect(existsSync(config.paths.dbPath)).toBe(false);
  });

  it("empty stdin (EOF, non-interactive) is treated as decline, not a hang", async () => {
    const stdio = createEofStdio();

    const exitCode = await runCli(["init"], { config, stdio });

    expect(exitCode).toBe(1);
    expect(existsSync(config.paths.dbPath)).toBe(false);
  });

  it("running init twice, accepting both times, is idempotent — the CLAUDE.md pointer is written once", async () => {
    await runCli(["init"], {
      config,
     
      stdio: createFakeStdio("y"),
    });
    const exitCode = await runCli(["init"], {
      config,
     
      stdio: createFakeStdio("y"),
    });

    expect(exitCode).toBe(0);
    const content = readFileSync(path.join(repoRoot, "CLAUDE.md"), "utf8");
    expect(content).toBe(CLAUDE_MD_POINTER);
  });
});
