// Behaviour tests for `signpost init` (R3, R8) at the CLI seam: real fs,
// real SQLite, a temp $HOME and a temp git repo, driven through runCli.

import { execFileSync, spawnSync } from "node:child_process";
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

  // Changed with "Fewer human steps" (19-value-to-a-user.md): init asked for
  // consent, then created `.signposts/`, the CLAUDE.md pointer and the skill in
  // the checkout. It asks nothing now and writes nothing the team shares: the
  // pointer rides in the first signposts commit and the skill in the plugin.
  it("sets the repo up without asking, and writes nothing into the checkout the team shares", async () => {
    const stdio = createFakeStdio();

    const exitCode = await runCli(["init"], { config, stdio });

    expect(exitCode).toBe(0);
    expect(stdio.writtenOutput()).not.toContain("Continue?");
    expect(existsSync(config.paths.knowledgeDir)).toBe(false);
    expect(existsSync(path.join(repoRoot, "CLAUDE.md"))).toBe(false);
    expect(existsSync(path.join(repoRoot, ".claude", "skills"))).toBe(false);

    const db = openDb(config.paths.dbPath);
    try {
      expect(hasConsented(db, repo)).toBe(true);
    } finally {
      db.close();
    }
  });


  it("re-running init is harmless, and says the repo is ready", async () => {
    await runCli(["init"], { config, stdio: createFakeStdio() });

    const secondStdio = createFakeStdio();
    const exitCode = await runCli(["init"], { config, stdio: secondStdio });

    expect(exitCode).toBe(0);
    expect(secondStdio.writtenOutput()).toContain("ready");
  });

  // 07-triggering-and-ux.md's second visibility surface. `init` installs it,
  // and it goes in settings.local.json: the command names an absolute path on
  // this machine, and a status line is a personal preference — neither belongs
  // in a file the team shares.
  it("installs the status line, into the settings file that is not committed", async () => {
    await runCli(["init"], { config, stdio: createFakeStdio() });

    const settings = JSON.parse(
      readFileSync(path.join(repoRoot, ".claude", "settings.local.json"), "utf8"),
    );
    expect(settings.statusLine.type).toBe("command");
    expect(settings.statusLine.command).toContain("statusline/statusline.js");
    expect(existsSync(path.join(repoRoot, ".claude", "settings.json"))).toBe(false);
  });

  // 19-value-to-a-user.md, open item 18: the cold walkthrough found init's
  // three paths untracked, one of them machine-local, and nothing said which.
  describe("what init leaves in the working tree", () => {
    const isIgnored = (relative: string) =>
      spawnSync("git", ["check-ignore", "-q", "--", relative], { cwd: repoRoot }).status === 0;

    // Claude Code adds `**/.claude/settings.local.json` to the global excludes
    // file the first time it writes one, so on a developer's machine the file
    // is often ignored already and these would pass without init doing a
    // thing. A repo-level excludesFile shadows the global one.
    beforeEach(() => {
      execFileSync("git", ["config", "core.excludesFile", "/dev/null"], { cwd: repoRoot });
    });

    it("keeps the settings file with this machine's install path out of git", async () => {
      await runCli(["init"], { config, stdio: createFakeStdio() });

      expect(isIgnored(".claude/settings.local.json")).toBe(true);
      // Through the repo's own exclude list, not the team's .gitignore.
      expect(existsSync(path.join(repoRoot, ".gitignore"))).toBe(false);
    });

    it("does not add the exclude twice", async () => {
      await runCli(["init"], { config, stdio: createFakeStdio() });
      await runCli(["init"], { config, stdio: createFakeStdio() });

      const exclude = readFileSync(path.join(repoRoot, ".git", "info", "exclude"), "utf8");
      expect(exclude.split(".claude/settings.local.json").length - 1).toBe(1);
    });




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
    const stdio = createFakeStdio();

    await runCli(["init"], { config, stdio });

    const settings = JSON.parse(
      readFileSync(path.join(repoRoot, ".claude", "settings.local.json"), "utf8"),
    );
    expect(settings.statusLine.command).toBe(
      `node '${statuslineScriptPath()}' --wrap '~/bin/mystatus.sh'`,
    );
    expect(settings.statusLine.padding).toBe(2);
    // Theirs kept, ours appended: the loop's two rules (src/core/init/permissions.ts).
    expect(settings.permissions).toEqual({
      allow: ["Bash", "Bash(signpost *)", `Edit(/${config.paths.repliesPath})`],
    });
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

    await runCli(["init"], { config, stdio: createFakeStdio() });

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

    const exitCode = await runCli(["init"], { config, stdio: createFakeStdio() });

    expect(exitCode).toBe(0);
    expect(readFileSync(settingsFile, "utf8")).toBe("{ half an edit");
  });


  // It used to read a consent answer, and a closed stdin was a decline.
  it("never reads stdin: a closed one neither hangs nor declines", async () => {
    const stdio = createEofStdio();

    const exitCode = await runCli(["init"], { config, stdio });

    expect(exitCode).toBe(0);
    expect(existsSync(config.paths.dbPath)).toBe(true);
  });

  it("running init twice adds the allow rules once", async () => {
    await runCli(["init"], { config, stdio: createFakeStdio() });
    const exitCode = await runCli(["init"], { config, stdio: createFakeStdio() });

    expect(exitCode).toBe(0);
    const settings = JSON.parse(readFileSync(path.join(repoRoot, ".claude", "settings.local.json"), "utf8"));
    expect(settings.permissions.allow).toEqual(["Bash(signpost *)", `Edit(/${config.paths.repliesPath})`]);
  });

  // 05-retrieval.md: "Prefetch happens at `signpost init`". Before it did,
  // the first thing to need the model was a background worker or a search
  // inside a Claude turn (19-value-to-a-user.md item 12).
  describe("fetching the embedding model", () => {
    function recordingPrefetch() {
      const calls: { consented: boolean }[] = [];
      const prefetchModel = async (_config: ResolvedConfig, say: (line: string) => void): Promise<void> => {
        const db = openDb(config.paths.dbPath);
        try {
          calls.push({ consented: hasConsented(db, repo) });
        } finally {
          db.close();
        }
        say("model fetched");
      };
      return { calls, prefetchModel };
    }

    it("fetches it once consent is recorded, and says so", async () => {
      const { calls, prefetchModel } = recordingPrefetch();
      const stdio = createFakeStdio();

      const exitCode = await runCli(["init"], { config, stdio, prefetchModel });

      expect(exitCode).toBe(0);
      expect(calls).toEqual([{ consented: true }]);
      expect(stdio.writtenOutput()).toContain("signposts: model fetched\n");
    });


    it("fetches it again on an already-initialised repo, which is the path an upgrade takes", async () => {
      await runCli(["init"], { config, stdio: createFakeStdio() });
      const { calls, prefetchModel } = recordingPrefetch();

      const exitCode = await runCli(["init"], { config, stdio: createFakeStdio(), prefetchModel });

      expect(exitCode).toBe(0);
      expect(calls).toEqual([{ consented: true }]);
    });
  });
});
