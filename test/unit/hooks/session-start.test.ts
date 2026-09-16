// Unit tests for the decisions the SessionStart hook makes, separated from
// the filesystem it makes them against. The spawn, the lockfile race and the
// wall-clock budget are behaviour, and live in
// test/behaviour/hooks/session-start.test.ts.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  IDLE_HOURS,
  LOCK_STALE_MINUTES,
  MAX_AGE_DAYS,
} from "../../../src/core/config/constants.ts";
import { derivePaths as deriveAppPaths } from "../../../src/core/config/paths.ts";
import {
  alreadyJudged,
  anyWork,
  countThreadsWaiting,
  derivePaths,
  findRepoRoot,
  judgedSessions,
  lockIsHeld,
  looksEligible,
  noticeFor,
  watermarkMs,
} from "../../../hooks/session-start.ts";

const NOW = Date.parse("2026-09-09T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("looksEligible", () => {
  const idleEnough = { lastActivityMs: NOW - 25 * HOUR, startedMs: NOW - 25 * HOUR };

  it("accepts a transcript idle past IDLE_HOURS and untouched since the last finished run", () => {
    expect(looksEligible(idleEnough, NOW, 0)).toBe(true);
  });

  it("rejects a transcript still inside the idle window", () => {
    const busy = { lastActivityMs: NOW - 23 * HOUR, startedMs: NOW - 23 * HOUR };
    expect(looksEligible(busy, NOW, 0)).toBe(false);
  });

  it("takes IDLE_HOURS exactly, matching src/core/eligibility's >=", () => {
    const exactly = { lastActivityMs: NOW - 24 * HOUR, startedMs: NOW - 24 * HOUR };
    expect(looksEligible(exactly, NOW, 0)).toBe(true);
  });

  it("rejects a transcript older than MAX_AGE_DAYS", () => {
    const ancient = { lastActivityMs: NOW - 91 * DAY, startedMs: NOW - 91 * DAY };
    expect(looksEligible(ancient, NOW, 0)).toBe(false);
  });

  // The watermark stands in for the processed-keys check, which needs the
  // database. A run that finished after the transcript's last activity has
  // already judged it.
  it("rejects a transcript the last finished run already saw", () => {
    expect(looksEligible(idleEnough, NOW, NOW - 2 * HOUR)).toBe(false);
  });

  it("accepts a transcript touched after the last finished run", () => {
    expect(looksEligible(idleEnough, NOW, NOW - 40 * HOUR)).toBe(true);
  });
});

describe("watermarkMs", () => {
  it("reads the last finished run", () => {
    expect(watermarkMs({ lastRunFinishedAt: "2026-09-08T00:00:00.000Z" })).toBe(
      Date.parse("2026-09-08T00:00:00.000Z"),
    );
  });

  // 0 means "consider every transcript" — the safe direction. A worker that
  // has never finished a run must not be able to suppress the first one.
  it("is 0 when the worker has never finished a run", () => {
    expect(watermarkMs({})).toBe(0);
  });

  it("is 0 rather than NaN when the stamp is unparseable", () => {
    expect(watermarkMs({ lastRunFinishedAt: "last tuesday" })).toBe(0);
  });
});

describe("countThreadsWaiting", () => {
  it("reads the count the worker wrote", () => {
    expect(countThreadsWaiting({ threadsWaiting: 3 })).toBe(3);
  });

  it("is 0 when the field is absent, negative, or not a number", () => {
    expect(countThreadsWaiting({})).toBe(0);
    expect(countThreadsWaiting({ threadsWaiting: -1 })).toBe(0);
    expect(countThreadsWaiting({ threadsWaiting: Number.NaN })).toBe(0);
    expect(countThreadsWaiting({ threadsWaiting: "2" as unknown as number })).toBe(0);
  });
});

describe("anyWork", () => {
  it("is false only when all three conditions are quiet", () => {
    expect(anyWork({ sessions: 0, threads: 0, staleIndex: false })).toBe(false);
    expect(anyWork({ sessions: 1, threads: 0, staleIndex: false })).toBe(true);
    expect(anyWork({ sessions: 0, threads: 1, staleIndex: false })).toBe(true);
    expect(anyWork({ sessions: 0, threads: 0, staleIndex: true })).toBe(true);
  });
});

describe("noticeFor", () => {
  // Only the index is rebuilt in the background. Sessions and threads need a
  // model call answered, and the worker has no session to answer it — so the
  // notice hands those to the developer rather than claiming them.
  it("claims the background only for the index", () => {
    expect(noticeFor({ sessions: 0, threads: 0, staleIndex: true })).toBe(
      "🪧 signposts: rebuilding the search index in the background",
    );
  });

  it("names the command for each thing that is waiting", () => {
    expect(noticeFor({ sessions: 3, threads: 0, staleIndex: false })).toBe(
      "🪧 signposts: 3 sessions ready — run `signpost run`",
    );
    expect(noticeFor({ sessions: 0, threads: 2, staleIndex: false })).toBe(
      "🪧 signposts: 2 changes need your review — run `signpost review`",
    );
  });

  it("singularises a count of one", () => {
    expect(noticeFor({ sessions: 1, threads: 1, staleIndex: false })).toBe(
      "🪧 signposts: 1 session ready — run `signpost run`; 1 change needs your review — run `signpost review`",
    );
  });

  it("separates what it is doing from what the developer must do", () => {
    expect(noticeFor({ sessions: 2, threads: 0, staleIndex: true })).toBe(
      "🪧 signposts: rebuilding the search index in the background; 2 sessions ready — run `signpost run`",
    );
  });
});

describe("the second copy of what src/ already knows", () => {
  // The hook may not import the application (07-triggering-and-ux.md), so it
  // carries its own transcription of 13-constants.md and its own copy of the
  // path derivation. Nothing but these tests stops the two drifting, which is
  // the whole risk that duplication buys.

  it("derives the same state paths as src/core/config/paths.ts", () => {
    for (const [repoRoot, homeDir, configDir] of [
      ["/repo", "/home/dev", undefined],
      ["/Users/greg/Projects/signposts", "/Users/greg", undefined],
      ["/repo", "/home/dev", "/elsewhere/cfg"],
      ["/repo", "/home/dev", ""],
    ] as const) {
      const mine = derivePaths(repoRoot, homeDir, configDir);
      const theirs = deriveAppPaths(repoRoot, homeDir, configDir);
      expect(mine.stateDir).toBe(theirs.stateDir);
      expect(mine.dbPath).toBe(theirs.dbPath);
      expect(mine.statuslineState).toBe(theirs.statuslineState);
      expect(mine.lockfile).toBe(theirs.lockfile);
      expect(mine.knowledgeDir).toBe(theirs.knowledgeDir);
      expect(mine.transcriptRoot).toBe(theirs.transcriptRoot);
    }
  });

  it("gates on the same IDLE_HOURS and MAX_AGE_DAYS the eligibility gate uses", () => {
    const at = (hoursAgo: number) => ({
      lastActivityMs: NOW - hoursAgo * HOUR,
      startedMs: NOW - hoursAgo * HOUR,
    });
    expect(looksEligible(at(IDLE_HOURS), NOW, 0)).toBe(true);
    expect(looksEligible(at(IDLE_HOURS - 0.001), NOW, 0)).toBe(false);

    const maxAgeHours = MAX_AGE_DAYS * 24;
    expect(looksEligible(at(maxAgeHours), NOW, 0)).toBe(true);
    expect(looksEligible(at(maxAgeHours + 0.001), NOW, 0)).toBe(false);
  });

  it("expires a lock at the same LOCK_STALE_MINUTES", () => {
    const lockfile = path.join(mkdtempSync(path.join(tmpdir(), "signposts-hook-lock-")), "run.lock");
    writeFileSync(lockfile, "{}");
    const heldSince = statSync(lockfile).mtimeMs;

    expect(lockIsHeld(lockfile, heldSince + LOCK_STALE_MINUTES * 60_000 - 1)).toBe(true);
    expect(lockIsHeld(lockfile, heldSince + LOCK_STALE_MINUTES * 60_000)).toBe(false);
    // Expiring it takes it over: a dead worker's lock must not survive the read.
    expect(existsSync(lockfile)).toBe(false);
  });
});

describe("findRepoRoot", () => {
  // STATE_DIR is sha256(repoRoot) over the path as given, and the worker the
  // hook spawns derives its own from `process.cwd()`, which Node always
  // reports resolved. A checkout reached through a symlink would otherwise
  // give the two processes different state directories: the hook would lock
  // one and read a status.json in it that the worker, writing to the other,
  // never touched.
  it("resolves the repo root through a symlink, matching a child's process.cwd()", () => {
    const base = realpathSync(mkdtempSync(path.join(tmpdir(), "signposts-hook-realpath-")));
    const real = path.join(base, "real-repo");
    const link = path.join(base, "linked-repo");
    mkdirSync(path.join(real, ".git"), { recursive: true });
    symlinkSync(real, link);

    expect(findRepoRoot(link)).toBe(real);

    const childCwd = execFileSync(process.execPath, ["-e", "console.log(process.cwd())"], {
      cwd: link,
      encoding: "utf8",
    }).trim();
    expect(findRepoRoot(link)).toBe(childCwd);
  });

  it("walks up to the nearest ancestor holding a .git", () => {
    const base = realpathSync(mkdtempSync(path.join(tmpdir(), "signposts-hook-walk-")));
    mkdirSync(path.join(base, ".git"), { recursive: true });
    const nested = path.join(base, "src", "deep");
    mkdirSync(nested, { recursive: true });

    expect(findRepoRoot(nested)).toBe(base);
  });

  it("is null outside a git repo", () => {
    const base = realpathSync(mkdtempSync(path.join(tmpdir(), "signposts-hook-nogit-")));
    expect(findRepoRoot(base)).toBeNull();
  });
});

// 19-value-to-a-user.md item 2: the sessions a run judged, read back by the hook.
describe("judgedSessions", () => {
  it("reads each entry as epoch ms", () => {
    expect(judgedSessions({ judgedSessions: { a: "2026-09-01T09:00:00.000Z" } })).toEqual({
      a: Date.parse("2026-09-01T09:00:00.000Z"),
    });
  });

  it("drops an entry that does not parse, so that transcript is counted rather than hidden", () => {
    const state = { judgedSessions: { bad: "yesterday", notString: 5, good: "2026-09-01T09:00:00.000Z" } };
    expect(judgedSessions(state as never)).toEqual({ good: Date.parse("2026-09-01T09:00:00.000Z") });
  });

  it("is empty when the field is absent or not an object", () => {
    expect(judgedSessions({})).toEqual({});
    expect(judgedSessions({ judgedSessions: null } as never)).toEqual({});
    expect(judgedSessions({ judgedSessions: "x" } as never)).toEqual({});
  });
});

describe("alreadyJudged", () => {
  const at = Date.parse("2026-09-01T09:00:00.000Z");

  it("matches the mtime it was judged at, allowing for the fraction a stat carries", () => {
    expect(alreadyJudged(at, at)).toBe(true);
    expect(alreadyJudged(at, at + 0.9)).toBe(true);
    expect(alreadyJudged(at, at - 0.9)).toBe(true);
  });

  it("does not match a transcript touched since", () => {
    expect(alreadyJudged(at, at + 1)).toBe(false);
    expect(alreadyJudged(at, at - 1)).toBe(false);
  });

  it("does not match a session nobody judged", () => {
    expect(alreadyJudged(undefined, at)).toBe(false);
  });
});
