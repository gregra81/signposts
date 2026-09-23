// Manual steps to first value (19-value-to-a-user.md, Phase 4's exit test).
//
// One fresh repository, walked the way a new user walks it: `init`, a session
// start that fires the hook, the worker it wakes, the run loop the skill
// drives, the developer's own `signpost review`, and the commit that lands on a
// branch with a pull request. Every link of that chain has tests of its own;
// nothing walked more than one link before this.
//
// What it measures is the one DevEx number available without a person: how
// many times a human has to answer something before the first signpost is in a
// pull request. Each is counted from what the system actually asked — the
// consent prompt `init` printed, the hook's instruction to offer the run and
// wait, every operation a review halt put in front of a person — never from
// what the test decided to type. Model calls are counted apart, because the
// Claude Code session answers those, not the developer.
//
// If the human count goes up, a change added a question. If it goes down,
// something got easier, and the assertion should move with it on purpose.
//
// Real throughout except two seams: the forge is FakeForge (no GitHub), and the
// worker the hook spawns is a no-op script — the real worker then runs
// in-process with `--adopt-lock`, as the spawned one would, so its effect on
// the state file is the real one.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig, type ResolvedConfig } from "../../../src/core/config/resolve.js";
import { projectDirName } from "../../../src/core/transcript/project-dir.js";
import type { WorkerStatus } from "../../../src/core/worker/status.js";
import type { RunOutput } from "../../../src/cli/protocol.js";
import { isModelRequest, type PendingRequest } from "../../../src/graph/index.js";
import { FakeForge } from "../../../src/io/forge/fake-forge.js";
import { makeOpenRun } from "../../../src/io/open-run.js";
import { makePublish } from "../../../src/io/commit/publish.js";
import { createFakeStdio, createScriptedStdio } from "../helpers/fake-stdio.js";
import { runCli } from "../helpers/run-cli.js";
import { testLocalModelPath, testModelCache } from "../../support/model-cache.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HOOK = path.join(ROOT, "hooks", "session-start.js");
const SESSION_ID = "01J9FIRSTVALUE";
const ORIGIN_URL = "git@github.com:acme/api.git";

/** What `init` prints when it asks (src/io/init/consent-prompt.ts). */
const CONSENT_QUESTION = "Continue? [y/N]";
/** What the hook tells the model to do with a ready session (hooks/session-start.ts, `contextFor`). */
const OFFER_AND_WAIT = "before your first tool call";

/** Corrections worth extracting, long enough to clear MIN_GUTTERED_TOKENS. */
function transcript(): string {
  const base = { parentUuid: null, sessionId: SESSION_ID, timestamp: "2026-08-01T09:00:00Z", cwd: "/repo", gitBranch: "main", isSidechain: false };
  const exchanges = [
    ["I will run the pending migration against the staging database now, and then verify the schema.", "No — staging is read only outside the ETL window, which runs 02:00 to 04:00 UTC every night. Run migrations against dev instead, and let the nightly job carry them to staging."],
    ["Understood. I will point the migration at dev and re-run the verification against staging afterwards.", "That works. Remember the permissions error you saw is what a read-only replica looks like — it is not a connection problem, so do not go looking at the network configuration again."],
    ["Should I also update the seed script so it targets dev by default?", "Yes, and never add a write path to staging in any script here. Every write must go through the ETL job, which is the only thing with credentials for the writable instance."],
    ["I will add a check to the deploy script that refuses a staging write outside the window.", "Do not put that check in the deploy script — it belongs in the migration runner, because the deploy script is generated from the terraform module and your change would be overwritten on the next plan."],
    ["Then I will regenerate the terraform module with the check built in.", "No. The terraform module is owned by the platform team and we do not fork it. Raise it with them if the runner check is not enough; meanwhile the runner check is what we ship."],
  ];
  return exchanges
    .flatMap(([assistant, human], index) => [
      JSON.stringify({ ...base, uuid: `a${String(index)}`, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: assistant }] } }),
      JSON.stringify({ ...base, uuid: `h${String(index)}`, type: "user", origin: { kind: "human" }, message: { role: "user", content: human } }),
    ])
    .join("\n");
}

/** How the Claude Code session answers a model call, the way the skill tells it to. */
function answerModelCall(pending: PendingRequest): unknown {
  if (!isModelRequest(pending.request)) {
    throw new Error("a review is the developer's to answer, not the session's");
  }
  switch (pending.request.node) {
    case "extract":
      return {
        candidates: [
          {
            tempId: "t1",
            claim: "Staging is read only outside the ETL window",
            category: "environment",
            scope: { repo: "acme/api" },
            evidence: "A migration against staging was refused with a permissions error.",
            confidence: 0.9,
            hedged: false,
          },
        ],
      };
    case "critic":
      return { verdicts: [{ tempId: "t1", keep: true, reason: "durable and not in the code" }] };
    case "classify":
      return { tempId: "t1", kind: "NOVEL", rationale: "nothing recorded is about this" };
    default:
      throw new Error(`unexpected node ${pending.request.node}`);
  }
}

describe("manual steps to first value", () => {
  let root: string;
  let homeDir: string;
  let repoRoot: string;
  let remote: string;
  let config: ResolvedConfig;
  let forge: FakeForge;

  beforeAll(() => {
    // The hook ships compiled, and the compiled file is what Claude Code runs.
    execFileSync(process.execPath, [path.join(ROOT, "scripts", "build-hooks.mjs")], { stdio: "pipe" });
  });

  beforeEach(() => {
    // Resolved, because the hook keys its state directory on the real path.
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "signposts-first-value-")));
    homeDir = path.join(root, "home");
    repoRoot = path.join(root, "checkout");
    remote = path.join(root, "remote.git");
    mkdirSync(homeDir, { recursive: true });

    execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", remote]);
    execFileSync("git", ["clone", "-q", remote, repoRoot]);
    for (const [key, value] of [["user.email", "greg@example.com"], ["user.name", "Greg"], ["commit.gpgsign", "false"]]) {
      execFileSync("git", ["config", key!, value!], { cwd: repoRoot });
    }
    writeFileSync(path.join(repoRoot, "README.md"), "# api\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: repoRoot });
    execFileSync("git", ["push", "-q", "-u", "origin", "main"], { cwd: repoRoot });
    // The repo key is read off `origin`; pushes go to the local bare remote.
    execFileSync("git", ["remote", "set-url", "origin", ORIGIN_URL], { cwd: repoRoot });
    execFileSync("git", ["config", "remote.origin.pushurl", remote], { cwd: repoRoot });

    const projectDir = path.join(homeDir, ".claude", "projects", projectDirName(repoRoot));
    mkdirSync(projectDir, { recursive: true });
    const transcriptPath = path.join(projectDir, `${SESSION_ID}.jsonl`);
    writeFileSync(transcriptPath, `${transcript()}\n`, "utf8");
    const idle = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    utimesSync(transcriptPath, idle, idle);

    config = resolveConfig({
      repoRoot,
      homeDir,
      repoFileContents: undefined,
      userFileContents: undefined,
      env: { SIGNPOSTS_RETRIEVAL_ALLOW_REMOTE_MODELS: "false", SIGNPOSTS_RETRIEVAL_LOCAL_MODEL_PATH: testLocalModelPath() },
    });
    config = { ...config, paths: { ...config.paths, modelCacheDir: testModelCache() } };
    forge = new FakeForge();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("takes four answers from a person to get one signpost into a pull request", async () => {
    const openRun = makeOpenRun(() => forge);
    const publish = makePublish(() => forge);
    let humanAnswers = 0;
    let modelAnswers = 0;

    // 1. init — asks for consent once.
    const init = createFakeStdio("y");
    expect(await runCli(["init"], { config, openRun, stdio: init }), init.writtenError()).toBe(0);
    humanAnswers += init.writtenOutput().split(CONSENT_QUESTION).length - 1;

    // 2. A session starts. The hook announces the session and tells the model
    //    to offer the run and wait: the developer answers that offer.
    const noop = path.join(root, "worker.js");
    writeFileSync(noop, "");
    const hook = spawnSync(process.execPath, [HOOK], {
      encoding: "utf8",
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: homeDir,
        CLAUDE_PROJECT_DIR: repoRoot,
        CLAUDE_CONFIG_DIR: path.join(homeDir, ".claude"),
        SIGNPOSTS_WORKER: noop,
      },
    });
    expect(hook.status, hook.stderr).toBe(0);
    const notice = JSON.parse(hook.stdout) as {
      systemMessage: string;
      hookSpecificOutput?: { additionalContext: string };
    };
    expect(notice.systemMessage).toContain("1 session ready");
    humanAnswers += notice.hookSpecificOutput?.additionalContext.includes(OFFER_AND_WAIT) === true ? 1 : 0;

    // 3. The worker the hook woke: reindexes and takes the census.
    expect(await runCli(["worker", "--adopt-lock"], { config, openRun, stdio: createFakeStdio() })).toBe(0);
    const census = JSON.parse(readFileSync(config.paths.statuslineState, "utf8")) as WorkerStatus;
    expect(census.eligibleSessions).toBe(1);

    // 4. The run loop, as the skill drives it: model calls answered by the
    //    session, a review halt handed back to the developer.
    const listed = createFakeStdio();
    await runCli(["sessions"], { config, openRun, stdio: listed });
    const [session] = (JSON.parse(listed.writtenOutput()) as { sessions: { sessionId: string }[] }).sessions;
    expect(session?.sessionId).toBe(SESSION_ID);

    const started = createFakeStdio();
    await runCli(["run", "--session", SESSION_ID, "--first"], { config, openRun, stdio: started });
    let output = JSON.parse(started.writtenOutput()) as RunOutput;
    const repliesPath = path.join(root, "replies.json");

    while (output.status === "waiting" && output.pending.every((pending) => isModelRequest(pending.request))) {
      modelAnswers += output.pending.length;
      const replies = Object.fromEntries(output.pending.map((pending) => [pending.id, answerModelCall(pending)]));
      writeFileSync(repliesPath, JSON.stringify({ replies }), "utf8");
      const resumed = createFakeStdio();
      await runCli(
        ["resume", "--session", SESSION_ID, "--content-hash", output.contentHash, "--replies", repliesPath],
        { config, openRun, stdio: resumed },
      );
      output = JSON.parse(resumed.writtenOutput()) as RunOutput;
    }

    // The first run in a repo sends everything to a person (06-review-and-pr.md,
    // "The bootstrap run"), so this is where the loop stops for one.
    expect(output.status).toBe("waiting");
    const operationsToDecide = output.pending
      .filter((pending) => !isModelRequest(pending.request))
      .reduce((sum, pending) => sum + (pending.request as { needsHuman: unknown[] }).needsHuman.length, 0);
    humanAnswers += operationsToDecide;

    // 5. The developer answers it at their own terminal, and it commits —
    //    locally, and nowhere else yet.
    const review = createScriptedStdio(Array.from({ length: operationsToDecide }, () => "a"));
    expect(await runCli(["review"], { config, openRun, stdio: review }), review.writtenError()).toBe(0);
    expect(forge.openPrCalls).toEqual([]);

    // 6. The developer is shown what was committed and says yes to publishing
    //    it. Before this step a run opened the pull request on its own, and the
    //    first thing a developer saw after a successful run was a PR nobody
    //    asked for (19-value-to-a-user.md, open item 1). This answer is the
    //    price of that, and the count below includes it.
    const published = createFakeStdio();
    expect(await runCli(["publish"], { config, openRun, publish, stdio: published }), published.writtenError()).toBe(0);
    humanAnswers += 1;

    // First value: one signpost, committed, on a branch with a pull request.
    expect(forge.openPrCalls).toHaveLength(1);
    const branch = forge.openPrCalls[0]!.branch;
    const files = execFileSync("git", ["ls-tree", "-r", "--name-only", branch], { cwd: remote, encoding: "utf8" });
    expect(files.split("\n").filter((file) => file.startsWith(".signposts/") && file.endsWith(".md") && !file.endsWith("index.md"))).toHaveLength(1);

    // The number this test exists for. Consent, the offer, one decision, and
    // the yes to publishing it.
    expect({ humanAnswers, modelAnswers }).toEqual({ humanAnswers: 4, modelAnswers: 3 });
  }, 120_000);
});
