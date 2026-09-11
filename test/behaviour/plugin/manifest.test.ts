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
import { detectSignpostPlugin } from "../../../src/core/doctor/report.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function read(relative: string): string {
  return readFileSync(path.join(PROJECT_ROOT, relative), "utf8");
}

function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(read(relative)) as Record<string, unknown>;
}

const manifest = readJson(".claude-plugin/plugin.json");
const packageJson = readJson("package.json");
/** What a global install puts on PATH — the only thing the manifest may name. */
const bin = packageJson["bin"] as Record<string, string>;

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

  it("is what `doctor` detects, now that it knows what an enabled plugin is", () => {
    // A plugin's hook is in hooks/hooks.json and in none of the three settings
    // files, so the settings check reported "not installed" to every plugin
    // user about a hook firing on every session. `enabledPlugins` is the trace
    // a plugin does leave in those files (18-end-to-end-gaps.md, "Spec drift").
    const enabled = { enabledPlugins: { [`${manifest["name"] as string}@any-marketplace`]: true } };

    expect(detectSignpostPlugin(enabled)).toBe(true);
  });

  it("runs a binary the package installs, not a file inside the clone", () => {
    const command = commandOf(hooks);

    // A plugin is installed by cloning its repository, and a clone carries
    // neither `node_modules` nor either compiled bundle — both are build
    // output and both are gitignored. So the manifest cannot point into the
    // clone; it names a binary that a global install of the npm package puts
    // on PATH (18-end-to-end-gaps.md, item 10).
    expect(command).toBe("signpost-session-start");
    expect(bin[command]).toBe("hooks/session-start.js");
    // Still the compiled bundle, not the source: type stripping on every
    // session start has no room in HOOK_BUDGET_MS.
    expect(bin[command]).not.toContain(".ts");
    expect(() => read("hooks/session-start.ts")).not.toThrow();
  });
});

/** The one command a hooks.json group runs. */
function commandOf(hooks: Record<string, unknown>): string {
  const groups = (hooks["hooks"] as Record<string, unknown>)["SessionStart"] as {
    hooks: { command: string }[];
  }[];
  return groups[0]!.hooks[0]!.command;
}

describe("the MCP server it registers", () => {
  const servers = manifest["mcpServers"] as Record<string, { command: string; args: string[]; env?: unknown }>;
  const server = servers["signposts"]!;

  it("starts the one CLI entry point, so it goes through the one composition root (R2)", () => {
    // The installed binary rather than `node ${CLAUDE_PLUGIN_ROOT}/bin/...`,
    // for the reason the hook uses one: a clone has no `node_modules`, so the
    // server died at `better-sqlite3` before reading a byte of stdin and
    // Claude Code showed CONNECTION_CLOSED.
    expect(server.command).toBe("signpost");
    expect(bin[server.command]).toBe("bin/signpost.js");
    expect(() => read(bin[server.command]!)).not.toThrow();
  });

  it("passes a subcommand the CLI dispatches, and one that cannot spend tokens", () => {
    const parsed = parseCommand(server.args);

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

  it.each([
    "bin/",
    // Both trees, and both earn their place. `dist/` is what an installed copy
    // runs, because Node refuses to strip types beneath node_modules
    // (18-end-to-end-gaps.md, item 9). `src/` stays because a consumer that
    // runs through `tsx` imports it directly — dropping it broke
    // `signposts-eval`, which is exactly the dependant CLAUDE.md's language
    // section describes.
    "src/",
    "dist/",
    ".claude-plugin/",
    "commands/",
    "hooks/hooks.json",
    "hooks/session-start.js",
    "statusline/statusline.js",
  ])(
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
