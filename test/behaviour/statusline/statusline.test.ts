// Behaviour tests for the shipped statusLine: the compiled
// `statusline/statusline.js`, run as its own process with session JSON on
// stdin, the way Claude Code runs it.
//
// The acceptance criterion in 07-triggering-and-ux.md is about what the
// developer sees — "shows progress during a run and nothing when idle" — so
// nothing here imports the module. `pnpm build:hooks` runs first, because the
// artifact under test is the build output.
//
// Two platform rules are load-bearing for every assertion below: a status line
// that prints nothing renders blank, and one that exits non-zero renders blank
// too. So "nothing to say" and "something went wrong" look identical to the
// developer, and the tests check the exit code even where they check for empty
// output.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { RUN_PROGRESS_STALE_MINUTES } from "../../../src/core/config/constants.ts";
import { hashRepoRoot } from "../../../src/core/config/paths.ts";
import type { WorkerStatus } from "../../../src/core/worker/status.ts";

const ROOT = path.dirname(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))));
const STATUSLINE = path.join(ROOT, "statusline", "statusline.js");

const MINUTE_MS = 60_000;

beforeAll(() => {
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "build-hooks.mjs")], { stdio: "pipe" });
});

interface Fixture {
  repoRoot: string;
  home: string;
  stateDir: string;
}

/** A git repo and an isolated home, keyed the way both processes key it. */
function fixture(): Fixture {
  // realpath for the same reason the hook's fixture does it: macOS hands back
  // a /var path that is a symlink to /private/var, and the statusLine resolves
  // before it hashes. A fixture computing stateDir from the unresolved path
  // would write to a directory the process under test never reads.
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "signposts-statusline-")));
  const repoRoot = path.join(base, "repo");
  const home = path.join(base, "home");
  mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
  return { repoRoot, home, stateDir: path.join(home, ".signposts", hashRepoRoot(repoRoot)) };
}

function withStatus(f: Fixture, status: Partial<WorkerStatus> | string): Fixture {
  mkdirSync(f.stateDir, { recursive: true });
  writeFileSync(
    path.join(f.stateDir, "status.json"),
    typeof status === "string" ? status : JSON.stringify(status),
  );
  return f;
}

/** The session JSON Claude Code puts on stdin. */
function sessionJson(f: Fixture): string {
  return JSON.stringify({
    cwd: f.repoRoot,
    session_id: "s-1",
    workspace: { current_dir: f.repoRoot, project_dir: f.repoRoot },
    model: { id: "claude-opus-5", display_name: "Opus" },
  });
}

function render(f: Fixture, args: string[] = [], stdin = sessionJson(f)) {
  return spawnSync(process.execPath, [STATUSLINE, ...args], {
    encoding: "utf8",
    input: stdin,
    env: { ...process.env, HOME: f.home },
  });
}

/** Progress as a run would have left it `minutesAgo`. */
function progress(minutesAgo: number, done: number, total: number, found: number): WorkerStatus {
  const at = new Date(Date.now() - minutesAgo * MINUTE_MS).toISOString();
  return {
    phase: "idle",
    updatedAt: at,
    eligibleSessions: 0,
    threadsWaiting: 0,
    runProgress: { sessionsDone: done, sessionsTotal: total, found, updatedAt: at },
  };
}

describe("nothing when idle", () => {
  it("says nothing with no state file at all", () => {
    const result = render(fixture());

    expect(result.stdout).toBe("");
    expect(result.status).toBe(0);
  });

  it("says nothing when the worker is idle with nothing waiting", () => {
    const f = withStatus(fixture(), {
      phase: "idle",
      updatedAt: new Date().toISOString(),
      eligibleSessions: 0,
      threadsWaiting: 0,
    });

    expect(render(f).stdout).toBe("");
  });

  // A backlog is the SessionStart hook's message to deliver, once. Repeating
  // it on a bar that is on screen permanently is how a notice becomes noise.
  it("says nothing about a backlog nobody has run", () => {
    const f = withStatus(fixture(), {
      phase: "idle",
      updatedAt: new Date().toISOString(),
      eligibleSessions: 5,
      threadsWaiting: 0,
    });

    expect(render(f).stdout).toBe("");
  });

  it("says nothing, and does not fail, on a state file it cannot parse", () => {
    const f = withStatus(fixture(), "{ this is not json");
    const result = render(f);

    expect(result.stdout).toBe("");
    expect(result.status).toBe(0);
  });

  it("says nothing outside a git repo", () => {
    const f = fixture();
    const result = render({ ...f, repoRoot: path.dirname(f.repoRoot) });

    expect(result.stdout).toBe("");
    expect(result.status).toBe(0);
  });
});

describe("progress during a run", () => {
  it("shows how far the run has got and what it has found", () => {
    const f = withStatus(fixture(), progress(1, 2, 3, 4));

    expect(render(f).stdout.trim()).toBe("🪧 signposts: 2/3 sessions · 4 signposts");
  });

  it("counts one signpost as one", () => {
    const f = withStatus(fixture(), progress(1, 1, 1, 1));

    expect(render(f).stdout.trim()).toBe("🪧 signposts: 1/1 sessions · 1 signpost");
  });

  // A terminal closed between two halts leaves progress on disk with nothing
  // to finish it. "2/3 sessions" for the rest of the week is a false claim.
  it("stops showing a run nothing has touched since RUN_PROGRESS_STALE_MINUTES", () => {
    const f = withStatus(fixture(), progress(RUN_PROGRESS_STALE_MINUTES + 1, 2, 3, 4));

    expect(render(f).stdout).toBe("");
  });

  it("shows the reindex the worker really is doing in the background", () => {
    const f = withStatus(fixture(), {
      phase: "running",
      updatedAt: new Date().toISOString(),
      eligibleSessions: 0,
      threadsWaiting: 0,
    });

    expect(render(f).stdout.trim()).toBe("🪧 signposts: indexing");
  });

  it("shows a review parked on the developer", () => {
    const f = withStatus(fixture(), {
      phase: "idle",
      updatedAt: new Date().toISOString(),
      eligibleSessions: 0,
      threadsWaiting: 2,
    });

    expect(render(f).stdout.trim()).toBe("🪧 signposts: 2 changes need your review");
  });

  // A detached worker's stderr goes to /dev/null, so this is the only place a
  // failure surfaces on its own.
  it("shows that the last run failed", () => {
    const f = withStatus(fixture(), {
      phase: "idle",
      updatedAt: new Date().toISOString(),
      eligibleSessions: 0,
      threadsWaiting: 0,
      lastError: "index rebuild exited 1",
    });

    expect(render(f).stdout.trim()).toBe("🪧 signposts: last run failed — run `signpost doctor`");
  });

  it("renders one row and no more", () => {
    const f = withStatus(fixture(), {
      ...progress(1, 2, 3, 4),
      threadsWaiting: 2,
      lastError: "something",
    });

    expect(render(f).stdout.trim().split("\n")).toHaveLength(1);
  });
});

// The developer may already live here. `init` wraps what it finds rather than
// replacing it (src/core/init/statusline-settings.ts), and this is the half
// that has to hold up its end.
describe("wrapping a status line that was already there", () => {
  it("prints theirs, then ours underneath", () => {
    const f = withStatus(fixture(), progress(1, 1, 2, 3));

    expect(render(f, ["--wrap", "echo 'main | 42% context'"]).stdout).toBe(
      "main | 42% context\n🪧 signposts: 1/2 sessions · 3 signposts\n",
    );
  });

  it("prints theirs alone when we have nothing to add", () => {
    expect(render(fixture(), ["--wrap", "echo 'main | 42% context'"]).stdout).toBe(
      "main | 42% context\n",
    );
  });

  // Their script gets the session JSON we were given, or every wrapped status
  // line loses the data it was written against.
  it("hands their command the same stdin", () => {
    const f = fixture();

    expect(render(f, ["--wrap", "cat"]).stdout.trim()).toBe(sessionJson(f));
  });

  // Exiting non-zero while printing something useful is common enough that
  // the platform's own examples do it. Dropping their output would be a
  // regression they would blame on us, correctly.
  it("keeps their output when their script exits non-zero", () => {
    const result = render(fixture(), ["--wrap", "echo 'still useful'; exit 1"]);

    expect(result.stdout).toBe("still useful\n");
    expect(result.status).toBe(0);
  });

  it("survives a wrapped command that does not exist", () => {
    const result = render(withStatus(fixture(), progress(1, 1, 2, 3)), [
      "--wrap",
      "definitely-not-a-command",
    ]);

    expect(result.stdout.trim()).toBe("🪧 signposts: 1/2 sessions · 3 signposts");
    expect(result.status).toBe(0);
  });

  it("keeps theirs even where signposts has never been set up", () => {
    const f = fixture();
    const outside = { ...f, repoRoot: path.dirname(f.repoRoot) };

    expect(render(outside, ["--wrap", "echo theirs"]).stdout).toBe("theirs\n");
  });
});
