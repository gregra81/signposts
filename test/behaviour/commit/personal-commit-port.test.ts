// Personal storage's write path, against real git: the store is a repository
// of its own under the state directory, created on the first commit, and the
// developer's checkout, its branches and its remote are never touched.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makePersonalCommitPort } from "../../../src/io/commit/commit-port.js";
import { makePublish } from "../../../src/io/commit/publish.js";
import type { CommitOutcome } from "../../../src/graph/ports.js";
import { resolveConfig } from "../../../src/core/config/resolve.js";
import { FakeForge } from "../../../src/io/forge/fake-forge.js";
import { parseSignpost } from "../../../src/core/signpost/codec.js";
import type { Operation } from "../../../src/core/contracts/graph.js";
import type { Signpost } from "../../../src/core/signpost/schema.js";

const AUTHOR = "dana@example.com";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function signpost(overrides: Partial<Signpost> = {}): Signpost {
  return {
    id: "staging-read-only",
    claim: "Staging is read only outside the ETL window",
    category: "environment",
    scope: { repo: "acme/api" },
    evidence: "A migration failed with a permissions error.",
    confidence: 0.9,
    provenance: {
      session_ids: ["sess-1"],
      authors: [AUTHOR],
      first_seen: "2026-01-01",
      last_reinforced: "2026-01-01",
    },
    status: "active",
    ...overrides,
  };
}

describe("the personal commit port", () => {
  let root: string;
  let repoRoot: string;
  let storeDir: string;
  let commits: CommitOutcome[];
  let warnings: string[];

  function commit(sessionId: string, operations: Operation[]) {
    return makePersonalCommitPort({
      repoRoot,
      storeDir,
      warn: (message) => warnings.push(message),
      committed: (outcome) => commits.push(outcome),
      today: () => "2026-10-14",
    }).apply({ repo: "acme/api", repoRoot, sessionId, operations, flagged: [] });
  }

  /**
   * A store that already exists, as on every commit after the first. Its own
   * identity, since CI has no global one, and no signing: the developer's
   * gitconfig may sign commits, and a temp repo has no key to sign with.
   */
  function prepareStore() {
    execFileSync("git", ["init", "--quiet", storeDir]);
    git(storeDir, "config", "user.email", AUTHOR);
    git(storeDir, "config", "user.name", "Dana");
    git(storeDir, "config", "commit.gpgsign", "false");
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "signposts-personal-"));
    repoRoot = path.join(root, "checkout");
    storeDir = path.join(root, "state", "corpus");
    commits = [];
    warnings = [];

    execFileSync("git", ["init", "--quiet", "--initial-branch=main", repoRoot]);
    // Set in the checkout only, so the store can only have it by copying it.
    git(repoRoot, "config", "user.email", AUTHOR);
    git(repoRoot, "config", "user.name", "Dana");
    git(repoRoot, "config", "commit.gpgsign", "false");
    writeFileSync(path.join(repoRoot, "README.md"), "# work in progress\n", "utf8");
    git(repoRoot, "add", "README.md");
    git(repoRoot, "commit", "--quiet", "-m", "initial");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("creates the store and commits the signpost and the index there", async () => {
    prepareStore();

    await commit("sess-1", [{ op: "add", signpost: signpost() }]);

    expect(parseSignpost(readFileSync(path.join(storeDir, "environment", "staging-read-only.md"), "utf8"))).toEqual(
      signpost(),
    );
    expect(readFileSync(path.join(storeDir, "index.md"), "utf8")).toContain("staging-read-only");
    expect(git(storeDir, "log", "-1", "--pretty=%s")).toBe("signposts: 1 from session sess-1");
    expect(git(storeDir, "status", "--porcelain")).toBe("");
    expect(commits).toEqual([{ branch: null, pr: null, store: storeDir }]);
  });

  it("leaves the checkout alone: no .signposts/, no CLAUDE.md, no branch", async () => {
    prepareStore();

    await commit("sess-1", [{ op: "add", signpost: signpost() }]);

    expect(existsSync(path.join(repoRoot, ".signposts"))).toBe(false);
    expect(existsSync(path.join(repoRoot, "CLAUDE.md"))).toBe(false);
    expect(git(repoRoot, "branch", "--format=%(refname:short)")).toBe("main");
    expect(git(repoRoot, "status", "--porcelain")).toBe("");
  });

  it("gives a new store the checkout's identity", async () => {
    // No pre-made store: the port creates it, and signing is off globally for
    // this one test through the environment rather than the store's config.
    process.env["GIT_CONFIG_COUNT"] = "1";
    process.env["GIT_CONFIG_KEY_0"] = "commit.gpgsign";
    process.env["GIT_CONFIG_VALUE_0"] = "false";
    try {
      await commit("sess-1", [{ op: "add", signpost: signpost() }]);
    } finally {
      delete process.env["GIT_CONFIG_COUNT"];
      delete process.env["GIT_CONFIG_KEY_0"];
      delete process.env["GIT_CONFIG_VALUE_0"];
    }

    expect(git(storeDir, "config", "user.email")).toBe(AUTHOR);
    expect(git(storeDir, "log", "-1", "--pretty=%ae")).toBe(AUTHOR);
  });

  it("puts each session in a commit of its own, so one can be reverted", async () => {
    prepareStore();

    await commit("sess-1", [{ op: "add", signpost: signpost() }]);
    await commit("sess-2", [{ op: "add", signpost: signpost({ id: "dates-are-utc", claim: "Dates are UTC" }) }]);

    expect(git(storeDir, "log", "--pretty=%s").split("\n")).toEqual([
      "signposts: 1 from session sess-2",
      "signposts: 1 from session sess-1",
    ]);
  });

  it("commits nothing for a session that proposed nothing", async () => {
    await commit("sess-1", []);

    expect(existsSync(storeDir)).toBe(false);
    expect(commits).toEqual([]);
  });

  it("gives publish nothing to do", async () => {
    const config = resolveConfig({ repoRoot, homeDir: root, env: { SIGNPOSTS_STORAGE: "personal" } });
    const forge = new FakeForge();

    expect(await makePublish(() => forge)({ config, repoRoot, warn: () => {} })).toBeNull();
    expect(forge.openPrCalls).toEqual([]);
  });
});
