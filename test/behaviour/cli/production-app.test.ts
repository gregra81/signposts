// The composition root as a process: what a person at a terminal sees when the
// environment is wrong (19-value-to-a-user.md item 5).
//
// Spawned against `src/io/production-app.ts` directly rather than through
// bin/signpost.js, because the wrapper prefers `dist/` and a checkout that
// built once runs whatever that build was — a stale `dist/` would test the
// previous version of the thing under test.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ENTRY = pathToFileURL(path.join(ROOT, "src", "io", "production-app.ts")).href;
const PACKAGE_VERSION = (JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string })
  .version;

describe("the production app, as a process", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "signposts-production-app-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function signpost(argv: string[], env: Record<string, string> = {}) {
    const script = `const { buildProductionApp } = await import(${JSON.stringify(ENTRY)});
process.exitCode = await buildProductionApp().run(process.argv.slice(1));`;
    return spawnSync(process.execPath, ["--input-type=module", "-e", script, "--", ...argv], {
      cwd: home,
      env: { PATH: process.env["PATH"] ?? "", HOME: home, ...env },
      encoding: "utf8",
    });
  }

  it("prints the package's version", () => {
    const result = signpost(["--version"]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${PACKAGE_VERSION}\n`);
  });

  it("ignores the installer's release pin rather than failing on it", () => {
    // docs/install.sh documents this variable. Exporting it used to throw
    // `"0.1.0" is not a valid number` out of every command, doctor included.
    const result = signpost(["--version"], { SIGNPOSTS_VERSION: "0.1.0" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("reports a bad config value as one line, not a stack trace", () => {
    const result = signpost(["doctor"], { SIGNPOSTS_CONFIG_VERSION: "abc" });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^signposts: SIGNPOSTS_CONFIG_VERSION: "abc" is not a valid number\n$/);
    expect(result.stdout).toBe("");
  });
});
