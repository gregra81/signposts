// Two developers, two machines, one remote — the premise of the product, end
// to end.
//
// Everything else in the suite tests one half of it. This is the whole
// sentence: a correction that exists only because a person typed it becomes
// something a different person, on a different machine, with a different
// database and a different transcript directory, is handed without either of
// them doing anything extra.
//
// Three outcomes, because they are the three ways the second session can
// relate to the first, and each has its own rule:
//
//   - it contradicts    -> the run pauses for a human and lands nothing
//   - it restates       -> one `reinforce` carrying both identities, never a
//                          second file
//   - it races          -> two branches, two pull requests, neither clobbered
//
// What is real here: two git checkouts of a shared bare remote, two state
// directories, two SQLite databases, two checkpointers, the embedder, the
// retrieval index, the gate, and the commit port's worktree, branch, commit
// and push. Two things are not. The model's answers arrive the way the Claude
// Code session supplies them — as `--replies` against the halt that asked, one
// process per halt — which is what production does too; and the forge is a
// FakeForge shared by both machines, standing in for the one GitHub they both
// push to. There is no gh here to be authenticated, and a stub gh on PATH
// would be testing the shell rather than the run.
//
// The remote is a local bare repository behind `remote.origin.pushurl`, while
// `origin` itself is the GitHub URL the repo key is derived from
// (src/core/git/owner-repo.ts parses no local path). So pushes are real and
// `git fetch origin` is not — which is the offline case the worktree code
// already treats as non-fatal, and every fetch this test needs, a person
// performs: the merge button is `git merge`, and the pull after it is `git
// pull`.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig, type ResolvedConfig } from "../../../src/core/config/resolve.js";
import { BRANCH_PATTERN, SIGNPOSTS_DIRNAME } from "../../../src/core/config/constants.js";
import { EXIT_CODES } from "../../../src/core/cli/exit-codes.js";
import { branchFor } from "../../../src/core/git/branch.js";
import { GATE_REASONS } from "../../../src/core/contracts/graph.js";
import { parseSignpost } from "../../../src/core/signpost/codec.js";
import { projectDirName } from "../../../src/core/transcript/project-dir.js";
import { FakeForge } from "../../../src/io/forge/fake-forge.js";
import { makeOpenRun } from "../../../src/io/open-run.js";
import { isModelRequest, REVIEW_REQUEST_KIND, type PendingRequest } from "../../../src/graph/index.js";
import type { OpenRun } from "../../../src/cli/run-port.js";
import { giveConsent, markPastBootstrap } from "../helpers/consent.js";
import { createFakeStdio } from "../helpers/fake-stdio.js";
import { runCli } from "../helpers/run-cli.js";
import { testLocalModelPath, testModelCache } from "../../support/model-cache.js";

const REPO = "acme/api";
const ORIGIN_URL = `https://github.example/${REPO}.git`;
const IDLE_DAYS = 3;
const TIMEOUT_MS = 180_000;

const DANA = "dana@acme.example";
const SAM = "sam@acme.example";

/** What Dana's session taught, and what Sam's three sessions each say about it. */
const READ_ONLY = "Staging is read only outside the ETL window";
const RESTATED = "You cannot write to staging except during the ETL window";
const CONTRADICTS = "Staging is writable by the ETL job at any time";
const UNRELATED = "The deploy script is generated from the terraform module and is never edited by hand";

interface RunOutput {
  sessionId: string;
  contentHash: string;
  status: "waiting" | "finished";
  pending: PendingRequest[];
  proposed: string[];
  commit: { branch: string; pr: number | null } | null;
}

/** One machine: a checkout, a home directory, and the state derived from both. */
interface Machine {
  email: string;
  repoRoot: string;
  homeDir: string;
  config: ResolvedConfig;
  /** The branch this machine's proposals land on today. */
  branch: string;
}

/** What the session driving the loop answers with, for one session's claim. */
interface Script {
  claim: string;
  /** Given the classify user turn — which carries the neighbours retrieved. */
  classify: (user: string) => unknown;
  /** Only reached when `classify` said CONTRADICTION. */
  resolve?: unknown;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * A transcript whose human turns are corrections, long enough to clear
 * MIN_GUTTERED_TOKENS — `lesson` is the one the session is about, the rest is
 * the ordinary traffic around it.
 */
function transcript(sessionId: string, lesson: string): string {
  const base = {
    parentUuid: null,
    sessionId,
    timestamp: "2026-08-01T09:00:00Z",
    cwd: "/repo",
    gitBranch: "main",
    isSidechain: false,
  };
  const exchanges = [
    ["I will run the pending migration against the staging database now.", `${lesson}. Point the migration at dev instead and let the nightly job carry it over.`],
    ["Understood. I will verify against staging afterwards.", "That works. The permissions error you saw is what a read-only replica looks like, not a connection problem, so stop reading the network configuration."],
    ["Should I update the seed script so it targets dev by default as well?", "Yes. Every write goes through the ETL job, which is the only thing holding credentials for the writable instance."],
    ["I will add a check to the deploy script that refuses a staging write.", "Not the deploy script — it is generated from the terraform module and your change would be overwritten. Put the check in the migration runner."],
    ["Then I will regenerate the terraform module with the check built in.", "No. The platform team owns that module and we do not fork it. Raise it with them; meanwhile the runner check is what we ship."],
  ];

  return exchanges
    .flatMap(([assistant, human], index) => [
      JSON.stringify({
        ...base,
        uuid: `a${String(index)}`,
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: assistant }] },
      }),
      JSON.stringify({
        ...base,
        uuid: `h${String(index)}`,
        type: "user",
        // `origin.kind` is what separates a person typing from a tool result
        // wearing a user hat — src/core/transcript/classify.ts.
        origin: { kind: "human" },
        message: { role: "user", content: human },
      }),
    ])
    .join("\n");
}

describe("two developers, one remote", () => {
  let root: string;
  let remote: string;
  let today: string;
  /** The one GitHub both machines push to. */
  let forge: FakeForge;
  let openRun: OpenRun;
  let dana: Machine;
  let sam: Machine;
  /** Every classify user turn either machine was given, in order. */
  let classifyTurns: string[];

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "signposts-two-devs-"));
    remote = path.join(root, "remote.git");
    forge = new FakeForge();
    classifyTurns = [];
    openRun = makeOpenRun(() => forge);
    today = new Date().toISOString().split("T")[0]!;

    execFileSync("git", ["init", "--bare", "--initial-branch=main", remote]);

    // Somebody's checkout, only to give the remote a main to branch from.
    const seed = path.join(root, "seed");
    execFileSync("git", ["clone", remote, seed]);
    for (const [key, value] of [["user.email", DANA], ["user.name", "Seed"], ["commit.gpgsign", "false"]]) {
      git(seed, "config", key!, value!);
    }
    writeFileSync(path.join(seed, "README.md"), "# api\n", "utf8");
    git(seed, "add", "README.md");
    git(seed, "commit", "-m", "initial");
    git(seed, "push", "-u", "origin", "main");

    dana = machine("dana", DANA);
    sam = machine("sam", SAM);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A developer's machine: their own checkout, home directory and state. */
  function machine(name: string, email: string): Machine {
    const homeDir = path.join(root, name, "home");
    const repoRoot = path.join(root, name, "checkout");
    mkdirSync(homeDir, { recursive: true });
    execFileSync("git", ["clone", remote, repoRoot]);
    for (const [key, value] of [["user.email", email], ["user.name", name], ["commit.gpgsign", "false"]]) {
      git(repoRoot, "config", key!, value!);
    }
    // `origin` is what the repo key is read off, and what git pushes to are
    // two different things here — see the header.
    git(repoRoot, "remote", "set-url", "origin", ORIGIN_URL);
    git(repoRoot, "config", "remote.origin.pushurl", remote);

    let config = resolveConfig({
      repoRoot,
      homeDir,
      repoFileContents: undefined,
      userFileContents: undefined,
      // The suite runs with the network denied, so the embedder reads the
      // model the global setup put on disk.
      env: {
        SIGNPOSTS_RETRIEVAL_ALLOW_REMOTE_MODELS: "false",
        SIGNPOSTS_RETRIEVAL_LOCAL_MODEL_PATH: testLocalModelPath(),
      },
    });
    config = { ...config, paths: { ...config.paths, modelCacheDir: testModelCache() } };

    giveConsent(config, repoRoot);
    markPastBootstrap(config, repoRoot);

    return { email, repoRoot, homeDir, config, branch: branchFor(BRANCH_PATTERN, email, today) };
  }

  /** A session Claude Code left behind on `machine`, idle long enough to run. */
  function writeTranscript(machine: Machine, sessionId: string, lesson: string): void {
    const projectDir = path.join(machine.homeDir, ".claude", "projects", projectDirName(machine.repoRoot));
    mkdirSync(projectDir, { recursive: true });
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
    writeFileSync(transcriptPath, `${transcript(sessionId, lesson)}\n`, "utf8");
    const idle = new Date(Date.now() - IDLE_DAYS * 24 * 60 * 60 * 1000);
    utimesSync(transcriptPath, idle, idle);
  }

  async function invoke(machine: Machine, argv: string[]): Promise<{ output: RunOutput; exitCode: number; stderr: string }> {
    const stdio = createFakeStdio();
    const exitCode = await runCli(argv, { config: machine.config, openRun, stdio });
    const stderr = stdio.writtenError();
    const written = stdio.writtenOutput();
    expect(written, `${argv.join(" ")} printed nothing: ${stderr}`).not.toBe("");
    return { output: JSON.parse(written) as RunOutput, exitCode, stderr };
  }

  /** The content hash half of a session's thread id, as `sessions` reports it. */
  async function contentHashOf(machine: Machine, sessionId: string): Promise<string> {
    const stdio = createFakeStdio();
    await runCli(["sessions"], { config: machine.config, openRun, stdio });
    const listed = JSON.parse(stdio.writtenOutput()) as {
      sessions: { sessionId: string; contentHash: string }[];
    };
    const found = listed.sessions.find((session) => session.sessionId === sessionId);
    expect(found, `${sessionId} is not eligible on ${machine.email}'s machine`).toBeDefined();
    return found!.contentHash;
  }

  /** One candidate, kept by the critic, classified as the script says. */
  function reply(script: Script, pending: PendingRequest): unknown {
    if (!isModelRequest(pending.request)) {
      throw new Error("the driver was asked to answer a review it should have stopped at");
    }

    switch (pending.request.node) {
      case "extract":
        return {
          candidates: [
            {
              tempId: "t1",
              claim: script.claim,
              category: "environment",
              scope: { repo: REPO },
              evidence: "The human corrected a migration run against staging.",
              confidence: 0.9,
              hedged: false,
            },
          ],
        };
      case "critic":
        return { verdicts: [{ tempId: "t1", keep: true, reason: "durable and specific" }] };
      case "classify":
        return script.classify(pending.request.user);
      case "resolve":
        if (script.resolve === undefined) {
          throw new Error("resolve_conflict ran but the script has no resolution");
        }
        return script.resolve;
    }
  }

  /**
   * Runs one session the way the skill does: `run --first`, then a `resume`
   * per halt, each its own invocation.
   *
   * A review halt ends the loop rather than being answered. Only the
   * developer can answer one, and whether the run stopped there at all is what
   * two of these tests are about.
   */
  async function runSession(
    machine: Machine,
    sessionId: string,
    script: Script,
  ): Promise<{ output: RunOutput; exitCode: number; stderr: string }> {
    const contentHash = await contentHashOf(machine, sessionId);
    const repliesPath = path.join(machine.homeDir, "replies.json");
    let result = await invoke(machine, ["run", "--session", sessionId, "--first"]);

    while (result.output.status === "waiting") {
      if (result.output.pending.some((pending) => !isModelRequest(pending.request))) {
        return result;
      }
      const replies = Object.fromEntries(
        result.output.pending.map((pending) => [pending.id, reply(script, pending)]),
      );
      writeFileSync(repliesPath, JSON.stringify({ replies }), "utf8");
      result = await invoke(machine, [
        "resume",
        "--session",
        sessionId,
        "--content-hash",
        contentHash,
        "--replies",
        repliesPath,
      ]);
    }

    return result;
  }

  /** Nothing retrieved is novel; anything retrieved is answered by `kind`. */
  function against(kind: string, rationale: string): (user: string) => unknown {
    return (user: string) => {
      classifyTurns.push(user);
      const relatedId = /"id":"([^"]+)"/.exec(user)?.[1];
      return relatedId === undefined
        ? { tempId: "t1", kind: "NOVEL", rationale: "nothing recorded is about this" }
        : { tempId: "t1", kind, relatedId, rationale };
    };
  }

  /** The signpost files a branch carries, `<category>/<id>.md` relative. */
  function corpusOn(worktreeDir: string): string[] {
    const knowledge = path.join(worktreeDir, SIGNPOSTS_DIRNAME);
    return readdirSync(knowledge, { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "index.md")
      .map((entry) => path.join(path.relative(knowledge, entry.parentPath), entry.name))
      .sort();
  }

  function branchesOnRemote(): string[] {
    return git(remote, "for-each-ref", "--format=%(refname:short)", "refs/heads/").split("\n").sort();
  }

  describe("after Dana's correction has merged", () => {
    const DANA_SESSION = "01DANAREADONLY";
    let signpostFile: string;

    beforeEach(async () => {
      writeTranscript(dana, DANA_SESSION, READ_ONLY);

      const danas = await runSession(dana, DANA_SESSION, {
        claim: READ_ONLY,
        classify: against("DUPLICATE", "unreachable — nothing is recorded yet"),
      });
      expect(danas.exitCode, danas.stderr).toBe(EXIT_CODES.ok);
      expect(danas.output.commit?.branch).toBe(dana.branch);

      // The merge button: Dana's pull request is reviewed and merged, which is
      // the only way a proposal becomes knowledge.
      git(dana.repoRoot, "fetch", remote, dana.branch);
      git(dana.repoRoot, "merge", "--ff-only", "FETCH_HEAD");
      git(dana.repoRoot, "push", remote, "main");
      forge.merge(dana.branch);

      // And Sam pulls, as anyone would. Nothing signposts does fetches for
      // them: the corpus travels in the repository like any other file.
      git(sam.repoRoot, "pull", "--ff-only", remote, "main");
      signpostFile = corpusOn(sam.repoRoot)[0]!;
      expect(signpostFile).toMatch(/^environment\//);
    }, TIMEOUT_MS);

    it("pauses for a human when Sam's session contradicts it, and lands nothing", async () => {
      const SAM_SESSION = "01SAMCONTRADICTS";
      writeTranscript(sam, SAM_SESSION, CONTRADICTS);

      const result = await runSession(sam, SAM_SESSION, {
        claim: CONTRADICTS,
        classify: against("CONTRADICTION", "the recorded claim says the opposite"),
        // The resolver looked and could not settle it, which is the ordinary
        // outcome when two people disagree about the same environment.
        resolve: {
          tempId: "t1",
          outcome: "undecidable",
          reasoning: "both claims are sourced from a person and neither is dated",
        },
      });

      // It stopped, and it stopped on the developer rather than on the model.
      expect(result.output.status).toBe("waiting");
      expect(result.output.pending).toHaveLength(1);
      const request = result.output.pending[0]!.request;
      expect(request.kind).toBe(REVIEW_REQUEST_KIND);
      expect(result.exitCode).toBe(EXIT_CODES.awaitingHuman);

      // And it is Dana's claim it was weighed against: merged knowledge that
      // reached Sam's classifier through the index, not somebody's outstanding
      // proposal.
      expect(classifyTurns.at(-1)).toContain(READ_ONLY);
      expect(classifyTurns.at(-1)).not.toContain('"pending"');

      // Held because of the contradiction, not because of confidence, not
      // because the repo is new: 0.9 clears AUTO_PUBLISH_CONFIDENCE and this
      // repo is past its bootstrap run.
      const needsHuman = (request as { needsHuman: { reason: string }[] }).needsHuman;
      expect(needsHuman.map((item) => item.reason)).toEqual([GATE_REASONS.unresolved_contradiction]);

      // And nothing landed anywhere. No commit, no branch, no pull request,
      // and Dana's claim on main still says what Dana said.
      expect(result.output.commit).toBe(null);
      // Dana's branch is still there — it is merged, not deleted — and Sam
      // has none at all.
      expect(branchesOnRemote()).toEqual([dana.branch, "main"].sort());
      expect(forge.openPrCalls).toHaveLength(1);
      expect(parseSignpost(readFileSync(path.join(sam.repoRoot, SIGNPOSTS_DIRNAME, signpostFile), "utf8")).claim)
        .toBe(READ_ONLY);
    }, TIMEOUT_MS);

    it("reinforces the one file with both identities when Sam's session restates it", async () => {
      const SAM_SESSION = "01SAMRESTATES";
      writeTranscript(sam, SAM_SESSION, RESTATED);

      const result = await runSession(sam, SAM_SESSION, {
        claim: RESTATED,
        classify: against("DUPLICATE", "the same lesson in different words"),
      });

      expect(result.exitCode, result.stderr).toBe(EXIT_CODES.ok);
      expect(result.output.status).toBe("finished");
      expect(result.output.proposed.join("\n")).toMatch(/^reinforce /);
      expect(result.output.proposed.join("\n")).not.toContain("add ");
      expect(classifyTurns.at(-1)).toContain(READ_ONLY);
      expect(classifyTurns.at(-1)).not.toContain('"pending"');

      // One file, not two — and it is Dana's file, now carrying Sam as well.
      // Both real git addresses, both session ids (12-wire-contracts.md: the
      // author is a real email, never a pseudonym).
      const worktree = sam.config.paths.worktreeDir;
      expect(corpusOn(worktree)).toEqual([signpostFile]);
      const signpost = parseSignpost(readFileSync(path.join(worktree, SIGNPOSTS_DIRNAME, signpostFile), "utf8"));
      expect(signpost.claim).toBe(READ_ONLY);
      expect(signpost.provenance.session_ids).toEqual([DANA_SESSION, SAM_SESSION]);
      expect(signpost.provenance.authors).toEqual([DANA, SAM]);

      // It went to Sam's own branch and Sam's own pull request, so Dana's
      // merged claim on main is untouched until someone merges this one too.
      expect(result.output.commit?.branch).toBe(sam.branch);
      expect(forge.openPrCalls.map((call) => call.branch)).toEqual([dana.branch, sam.branch]);
      expect(git(remote, "log", "--pretty=%s", "-1", "main")).not.toContain(SAM_SESSION);
    }, TIMEOUT_MS);
  });

  it("keeps both proposals when the two sessions land at the same time", async () => {
    // Neither developer has seen the other's work: both branch off the same
    // main, both push, and nothing merges in between.
    const DANA_SESSION = "01DANARACES";
    const SAM_SESSION = "01SAMRACES";
    writeTranscript(dana, DANA_SESSION, READ_ONLY);
    writeTranscript(sam, SAM_SESSION, UNRELATED);

    const danas = await runSession(dana, DANA_SESSION, {
      claim: READ_ONLY,
      classify: against("DUPLICATE", "unreachable — nothing is recorded yet"),
    });
    const sams = await runSession(sam, SAM_SESSION, {
      claim: UNRELATED,
      classify: against("DUPLICATE", "unreachable — Sam cannot see Dana's branch"),
    });

    for (const result of [danas, sams]) {
      expect(result.exitCode, result.stderr).toBe(EXIT_CODES.ok);
      expect(result.stderr).not.toContain("could not push");
      expect(result.output.proposed.join("\n")).toContain("add ");
    }

    // Two branches, two pull requests, and main is where it was.
    expect(branchesOnRemote()).toEqual([dana.branch, "main", sam.branch].sort());
    expect(forge.openPrCalls.map((call) => call.branch)).toEqual([dana.branch, sam.branch]);
    expect(danas.output.commit?.pr).not.toBe(sams.output.commit?.pr);
    expect(git(remote, "rev-parse", "main")).toBe(git(dana.repoRoot, "rev-parse", "origin/main"));

    // Neither branch overwrote the other: each carries exactly its own claim,
    // one commit past the main they both started from.
    const danaFile = corpusOn(dana.config.paths.worktreeDir);
    const samFile = corpusOn(sam.config.paths.worktreeDir);
    expect(danaFile).toHaveLength(1);
    expect(samFile).toHaveLength(1);
    expect(danaFile).not.toEqual(samFile);
    for (const [machine, file, claim] of [
      [dana, danaFile[0]!, READ_ONLY],
      [sam, samFile[0]!, UNRELATED],
    ] as const) {
      const worktree = machine.config.paths.worktreeDir;
      expect(parseSignpost(readFileSync(path.join(worktree, SIGNPOSTS_DIRNAME, file), "utf8")).claim).toBe(claim);
      expect(git(remote, "rev-list", "--count", `main..${machine.branch}`)).toBe("1");
      expect(git(remote, "rev-parse", machine.branch)).toBe(git(worktree, "rev-parse", "HEAD"));
    }
  }, TIMEOUT_MS);
});
