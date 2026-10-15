// Personal storage's write path: the store is a plain folder under the state
// directory, written on the first session that proposes anything, and the
// developer's checkout, its branches and its remote are never touched.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makePersonalCommitPort } from "../../../src/io/commit/commit-port.js";
import { makePublish } from "../../../src/io/commit/publish.js";
import type { CommitInput, CommitOutcome } from "../../../src/graph/ports.js";
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

  function commit(sessionId: string, operations: Operation[], flagged: CommitInput["flagged"] = []) {
    return makePersonalCommitPort({
      storeDir,
      warn: (message) => warnings.push(message),
      committed: (outcome) => commits.push(outcome),
      today: () => "2026-10-14",
    }).apply({ repo: "acme/api", repoRoot, sessionId, operations, flagged });
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "signposts-personal-"));
    repoRoot = path.join(root, "checkout");
    storeDir = path.join(root, "state", "corpus");
    commits = [];
    warnings = [];

    execFileSync("git", ["init", "--quiet", "--initial-branch=main", repoRoot]);
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

  it("writes the signpost and the index into the store, which is not a git repository", async () => {
    await commit("sess-1", [{ op: "add", signpost: signpost() }]);

    expect(parseSignpost(readFileSync(path.join(storeDir, "environment", "staging-read-only.md"), "utf8"))).toEqual(
      signpost(),
    );
    expect(readFileSync(path.join(storeDir, "index.md"), "utf8")).toContain("staging-read-only");
    expect(existsSync(path.join(storeDir, ".git"))).toBe(false);
    expect(commits).toEqual([{ branch: null, pr: null, store: storeDir, flagged: [] }]);
  });

  it("leaves the checkout alone: no .signposts/, no CLAUDE.md, no branch", async () => {
    await commit("sess-1", [{ op: "add", signpost: signpost() }]);

    expect(existsSync(path.join(repoRoot, ".signposts"))).toBe(false);
    expect(existsSync(path.join(repoRoot, "CLAUDE.md"))).toBe(false);
    expect(git(repoRoot, "branch", "--format=%(refname:short)")).toBe("main");
    expect(git(repoRoot, "status", "--porcelain")).toBe("");
  });

  // There is no pull request or commit message to carry them, so the outcome does.
  it("hands back what the gate flagged, with the reason", async () => {
    const add: Operation = { op: "add", signpost: signpost() };
    await commit("sess-1", [add], [{ operation: add, reason: "bootstrap_run" }]);

    expect(commits[0]?.flagged).toEqual(["add staging-read-only — this repo's first run, so everything is flagged"]);
  });

  it("adds a later session's signposts beside the earlier ones", async () => {
    await commit("sess-1", [{ op: "add", signpost: signpost() }]);
    await commit("sess-2", [{ op: "add", signpost: signpost({ id: "dates-are-utc", claim: "Dates are UTC" }) }]);

    const index = readFileSync(path.join(storeDir, "index.md"), "utf8");
    expect(index).toContain("staging-read-only");
    expect(index).toContain("dates-are-utc");
  });

  it("writes nothing for a session that proposed nothing", async () => {
    await commit("sess-1", []);

    expect(existsSync(storeDir)).toBe(false);
    expect(commits).toEqual([]);
  });

  it("gives publish nothing to do", async () => {
    const config = resolveConfig({ repoRoot, homeDir: root, env: {}, checkoutFileContents: "storage: personal\n" });
    const forge = new FakeForge();

    expect(await makePublish(() => forge)({ config, repoRoot, warn: () => {} })).toBeNull();
    expect(forge.openPrCalls).toEqual([]);
  });
});
