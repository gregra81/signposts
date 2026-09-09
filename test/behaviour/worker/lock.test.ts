// The run lock, against a real filesystem: the half of "five terminals don't
// start five workers" that lives in the worker (07-triggering-and-ux.md).

import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LOCK_STALE_MINUTES } from "../../../src/core/config/constants.ts";
import { lockHolder, takeLock } from "../../../src/io/worker/lock.ts";

const NOW = new Date("2026-09-09T12:00:00.000Z");
const MINUTE_MS = 60_000;

function stateDir(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "signposts-worker-lock-")), "state");
}

function take(dir: string, pid: number, adopt = false) {
  return takeLock({ lockfile: path.join(dir, "run.lock"), stateDir: dir, pid, now: NOW, adopt });
}

describe("takeLock", () => {
  it("creates the state directory and records the holder", () => {
    const dir = stateDir();
    const lock = take(dir, 4242);

    expect(lock.held).toBe(true);
    expect(lockHolder(path.join(dir, "run.lock"))).toBe(4242);
  });

  it("releases by removing the file, so the next worker can take it", () => {
    const dir = stateDir();
    const first = take(dir, 1);
    expect(first.held).toBe(true);
    if (first.held) {
      first.release();
    }

    expect(existsSync(path.join(dir, "run.lock"))).toBe(false);
    expect(take(dir, 2).held).toBe(true);
  });

  it("refuses when a live worker already holds it", () => {
    const dir = stateDir();
    expect(take(dir, 1).held).toBe(true);
    expect(take(dir, 2).held).toBe(false);
  });

  // The terminal was killed mid-run. Nothing else will ever remove that file.
  it("takes over a lock older than LOCK_STALE_MINUTES", () => {
    const dir = stateDir();
    take(dir, 1);
    const lockfile = path.join(dir, "run.lock");
    const dead = new Date(NOW.getTime() - (LOCK_STALE_MINUTES + 1) * MINUTE_MS);
    utimesSync(lockfile, dead, dead);

    expect(take(dir, 2).held).toBe(true);
    expect(lockHolder(lockfile)).toBe(2);
  });

  // The hook took the lock before spawning us, so competing for it would mean
  // the worker always losing to the hook that started it.
  it("adopts the hook's lock, stamping its own pid over it", () => {
    const dir = stateDir();
    expect(take(dir, 111).held).toBe(true); // the hook

    const worker = take(dir, 222, true);
    expect(worker.held).toBe(true);
    expect(lockHolder(path.join(dir, "run.lock"))).toBe(222);
  });

  it("reports no holder for an unreadable lockfile", () => {
    const dir = stateDir();
    take(dir, 1);
    writeFileSync(path.join(dir, "run.lock"), "not json");
    expect(lockHolder(path.join(dir, "run.lock"))).toBeUndefined();
    expect(lockHolder(path.join(dir, "absent.lock"))).toBeUndefined();
  });

  it("survives a release called twice", () => {
    const dir = stateDir();
    const lock = take(dir, 1);
    if (lock.held) {
      lock.release();
      expect(() => lock.release()).not.toThrow();
    }
  });
});

describe("the lockfile the hook reads", () => {
  // The hook judges staleness by mtime and reads the pid for diagnostics, so
  // the file has to be both fresh and parseable the moment it exists.
  it("is valid JSON carrying pid and startedAt", () => {
    const dir = stateDir();
    take(dir, 99);
    const written = JSON.parse(readFileSync(path.join(dir, "run.lock"), "utf8"));

    expect(written.pid).toBe(99);
    expect(written.startedAt).toBe(NOW.toISOString());
  });
});
