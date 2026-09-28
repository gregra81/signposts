// A behaviour test for scripts/build-hooks.mjs's own concurrency safety, not
// for what it builds — the hook's and the statusline's own behaviour test
// files already cover that, and each already runs this script once in its
// own `beforeAll`. It lives here, beside those, because what it proves is
// only provable against a real filesystem: several real processes racing to
// write the same two files. Nothing under test/unit can stand in for that.
//
// The gap this closes: those four `beforeAll`s run in vitest's parallel
// workers, so a reader can in principle open hooks/session-start.js or
// statusline/statusline.js while a concurrent build is mid-write. A plain
// writeFileSync would let that reader see a truncated file — the incident
// this guards against. Running it once would still pass most of the time
// (a truncated read is a race, not a certainty), which is why this fires
// several builds at once rather than asserting from reading the source.

import { execFileSync, spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.dirname(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))));
const SCRIPT = path.join(ROOT, "scripts", "build-hooks.mjs");
const CONCURRENT_BUILDS = 8;

function runBuild(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`build-hooks.mjs exited ${String(code)}`));
      }
    });
  });
}

/** Syntax-checks a file without running it — `node --check` parses and exits. */
function assertParses(file: string): void {
  execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
}

describe("build-hooks.mjs under concurrent writers", () => {
  it("leaves both bundles whole and no temp files behind", async () => {
    await Promise.all(Array.from({ length: CONCURRENT_BUILDS }, () => runBuild()));

    const hook = path.join(ROOT, "hooks", "session-start.js");
    const statusline = path.join(ROOT, "statusline", "statusline.js");

    for (const file of [hook, statusline]) {
      expect(statSync(file).size).toBeGreaterThan(0);
      expect(() => assertParses(file)).not.toThrow();
    }

    for (const directory of [path.join(ROOT, "hooks"), path.join(ROOT, "statusline")]) {
      const leftovers = readdirSync(directory).filter((entry) => entry.includes(".tmp"));
      expect(leftovers).toEqual([]);
    }
  });
});
