// The plugin manifest, checked against the repo it points into
// (07-triggering-and-ux.md, "Distribution: a Claude Code plugin").
//
// A manifest is wiring, and wiring fails silently: a path that no longer
// exists, a command Claude Code spawns that the CLI does not recognise, a
// bundle left out of the published tarball. None of that shows up in a test
// of the thing being wired, and all of it shows up as "the plugin installed
// and nothing happened". So each reference is resolved here against what is
// actually on disk.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCommand, spendsTokens } from "../../../src/core/cli/dispatch.js";
import { detectSignpostSessionStartHook } from "../../../src/core/doctor/report.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function read(relative: string): string {
  return readFileSync(path.join(PROJECT_ROOT, relative), "utf8");
}

function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(read(relative)) as Record<string, unknown>;
}

/** `${CLAUDE_PLUGIN_ROOT}/bin/signpost.js` -> `bin/signpost.js`. */
const PLUGIN_ROOT_VARIABLE = "${CLAUDE_PLUGIN_ROOT}/";

function repoRelative(pluginPath: string): string {
  return pluginPath.replace(PLUGIN_ROOT_VARIABLE, "").replaceAll('"', "");
}

const manifest = readJson(".claude-plugin/plugin.json");
const packageJson = readJson("package.json");

describe("the plugin manifest", () => {
  it("names the plugin, which is also the namespace its commands answer on", () => {
    expect(manifest["name"]).toBe("signposts");
  });

  it("points at paths that exist", () => {
    for (const key of ["hooks", "commands"]) {
      const declared = manifest[key];
      expect(typeof declared).toBe("string");
      expect(existsSync(path.join(PROJECT_ROOT, declared as string))).toBe(true);
    }
  });
});

describe("the SessionStart hook it installs", () => {
  const hooks = readJson("hooks/hooks.json");

  it("is the shape Claude Code reads for a SessionStart hook", () => {
    // `{ hooks: { SessionStart: [{ hooks: [{ type, command }] }] }}` — the
    // same shape a settings file uses, which is what lets the plugin install
    // it without the developer editing one.
    const groups = (hooks["hooks"] as Record<string, unknown>)["SessionStart"] as {
      hooks: { type: string; command: string }[];
    }[];

    expect(groups).toHaveLength(1);
    expect(groups[0]!.hooks[0]!.type).toBe("command");
  });

  it("is not what `doctor` detects, and that is a known gap", () => {
    // src/io/doctor/hook-settings.ts looks for a signposts hook in the three
    // settings files, because that is where one used to have to be installed
    // by hand. A plugin's hook lives in this file instead, and the command it
    // runs is written in terms of ${CLAUDE_PLUGIN_ROOT} — so `doctor` reports
    // "not installed" for a plugin user whose hook fires on every session.
    // Recorded here rather than left as a surprise: fixing it means teaching
    // `doctor` what an enabled plugin looks like.
    expect(detectSignpostSessionStartHook(hooks)).toBe(false);
  });

  it("runs the compiled bundle, not the TypeScript it is stripped from", () => {
    const command = JSON.stringify(hooks);

    // `pnpm build:hooks` writes the `.js` beside its source; the `.ts` is what
    // is committed, and shipping the source would pay type stripping on every
    // session start (HOOK_BUDGET_MS).
    expect(command).toContain("hooks/session-start.js");
    expect(command).not.toContain("hooks/session-start.ts");
    expect(() => read("hooks/session-start.ts")).not.toThrow();
  });
});

describe("the MCP server it registers", () => {
  const servers = manifest["mcpServers"] as Record<string, { command: string; args: string[]; env?: unknown }>;
  const server = servers["signposts"]!;

  it("starts the one CLI entry point, so it goes through the one composition root (R2)", () => {
    expect(server.command).toBe("node");
    expect(() => read(repoRelative(server.args[0]!))).not.toThrow();
    expect(repoRelative(server.args[0]!)).toBe("bin/signpost.js");
  });

  it("passes a subcommand the CLI dispatches, and one that cannot spend tokens", () => {
    const parsed = parseCommand(server.args.slice(1));

    expect(parsed.name).toBe("mcp");
    expect(spendsTokens("mcp")).toBe(false);
  });

  it("tells the server which repository it is answering for", () => {
    // Claude Code documents the variables a manifest may substitute but not
    // the working directory a server is spawned in, and a repoRoot guessed
    // wrong reads as an index that does not exist — see
    // src/io/production-app.ts's resolveRepoRoot.
    expect(server.env).toEqual({ SIGNPOSTS_REPO_ROOT: "${CLAUDE_PROJECT_DIR}" });
  });
});

describe("what the published package carries", () => {
  const files = packageJson["files"] as string[];

  it.each([".claude-plugin/", "commands/", "hooks/hooks.json", "hooks/session-start.js", "statusline/statusline.js"])(
    "ships %s",
    (entry) => {
      expect(files).toContain(entry);
    },
  );
});

describe("the slash commands", () => {
  it.each(["run", "status", "review"])("/signposts:%s declares a name and a description", (name) => {
    const contents = read(path.join("commands", `${name}.md`));
    const [, frontmatter] = contents.split("---\n");

    expect(frontmatter).toContain(`name: ${name}`);
    expect(frontmatter).toMatch(/description: .+/);
  });
});
