// `resolveWorker` answers one question: is there an entry point to spawn.
// Whether the process it starts survives is `lockIsHeld`'s problem — it checks
// the holder is still running, so a worker that dies for any reason frees the
// lock at the next session start (18-end-to-end-gaps.md item 10).

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

  it("finds the wrapper under the package root", () => {
    write(bin);

    expect(resolveWorker({}, root)).toBe(path.join(root, bin));
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
