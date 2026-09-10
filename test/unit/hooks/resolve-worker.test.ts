// 18-end-to-end-gaps.md item 10. A plugin is installed by cloning its
// repository, and a clone of this one carries neither `node_modules` nor the
// compiled `dist/` — both are build output and both are gitignored. So
// `bin/signpost.js` was there, the hook took the run lock and spawned it, and
// the worker died at its first import with its stderr going to /dev/null,
// because a detached spawn has nowhere to put it. The worker is what releases
// the lock, so the lock sat for LOCK_STALE_MINUTES and the hook said nothing
// for an hour after every wake.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveWorker } from "../../../hooks/session-start.ts";

describe("resolveWorker", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "signposts-worker-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function write(relative: string): void {
    const absolute = path.join(root, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, "", "utf8");
  }

  const bin = path.join("bin", "signpost.js");

  it("finds the wrapper in a checkout, which runs src/ with no build", () => {
    write(bin);
    write(path.join("src", "io", "production-app.ts"));

    expect(resolveWorker({}, root)).toBe(path.join(root, bin));
  });

  it("finds it in an installed copy, which runs the stripped dist/", () => {
    write(bin);
    write(path.join("dist", "io", "production-app.js"));

    expect(resolveWorker({}, root)).toBe(path.join(root, bin));
  });

  it("refuses a clone that has the wrapper and nothing for it to import", () => {
    write(bin);

    expect(resolveWorker({}, root)).toBe(null);
  });

  it("refuses a root with no wrapper at all", () => {
    expect(resolveWorker({}, root)).toBe(null);
  });

  it("takes an override at its word — it is a stub, not the application", () => {
    const stub = path.join(root, "stub.js");
    writeFileSync(stub, "", "utf8");

    expect(resolveWorker({ SIGNPOSTS_WORKER: stub }, root)).toBe(stub);
  });

  it("refuses an override that is not there", () => {
    expect(resolveWorker({ SIGNPOSTS_WORKER: path.join(root, "absent.js") }, root)).toBe(null);
  });
});
