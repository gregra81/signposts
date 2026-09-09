// Reindexing between the sessions of one run, through the commands a user
// actually runs (06-review-and-pr.md, "Reindex within a run, not only at
// commit").
//
// The failure is silent and it is a cold-start one: two sessions in the same
// run where the same lesson was taught in different words. Process them
// against the index as it stood when the run began and both retrieve nothing,
// both classify NOVEL, and the pull request carries two near-identical `add`s
// that no classifier ever compared.
//
// The property lives at this level rather than around the graph because this
// is where the loop lives now — the skill drives `run` and `resume`, one
// session at a time, and a session may sit at a review between the two. What
// it proposed has to be visible to the next session anyway: a review that
// takes three days must not make a claim invisible for three days.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig, type ResolvedConfig } from "../../../src/core/config/resolve.js";
import { projectDirName } from "../../../src/core/transcript/project-dir.js";
import { operationKey } from "../../../src/core/graph/decisions.js";
import { EXIT_CODES } from "../../../src/core/cli/exit-codes.js";
import { runCli } from "../helpers/run-cli.js";
import { giveConsent } from "../helpers/consent.js";
import { createFakeStdio } from "../helpers/fake-stdio.js";
import { testLocalModelPath, testModelCache } from "../../support/model-cache.js";
import { isModelRequest, type PendingRequest } from "../../../src/graph/index.js";

const AUTHOR = "greg@example.com";
const IDLE_DAYS = 3;

/** The same lesson, in the words each session used. */
const FIRST_CLAIM = "Staging is read only outside the ETL window";
const SECOND_CLAIM = "You cannot write to staging except during the ETL window";

const SESSIONS = [
  { id: "01SESSIONONE", claim: FIRST_CLAIM },
  { id: "01SESSIONTWO", claim: SECOND_CLAIM },
];

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
    ["I will run the pending migration against the staging database now.", `${lesson}. Run migrations against dev instead and let the nightly job carry them over.`],
    ["Understood, I will point the migration at dev and verify against staging after.", "That works. The permissions error you saw is what a read-only replica looks like, not a connection problem, so stop reading the network configuration."],
    ["Should I update the seed script so it targets dev by default as well?", "Yes, and never add a write path to staging in any script here. Every write goes through the ETL job, which is the only thing holding credentials for the writable instance."],
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
        origin: { kind: "human" },
        message: { role: "user", content: human },
      }),
    ])
    .join("\n");
}

interface RunOutput {
  sessionId: string;
  status: string;
  pending: PendingRequest[];
  proposed: string[];
}

describe("two sessions in one run", () => {
  let root: string;
  let homeDir: string;
  let repoRoot: string;
  let config: ResolvedConfig;
  let repliesPath: string;
  /** Every classify request either session was given, in order. */
  let classifyTurns: string[];

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "signposts-reindex-"));
    homeDir = path.join(root, "home");
    repoRoot = path.join(root, "checkout");
    repliesPath = path.join(root, "replies.json");
    classifyTurns = [];
    mkdirSync(homeDir, { recursive: true });

    const remote = path.join(root, "remote.git");
    execFileSync("git", ["init", "--bare", "--initial-branch=main", remote]);
    execFileSync("git", ["clone", remote, repoRoot]);
    for (const [key, value] of [
      ["user.email", AUTHOR],
      ["user.name", "Greg"],
      ["commit.gpgsign", "false"],
    ]) {
      execFileSync("git", ["config", key!, value!], { cwd: repoRoot });
    }
    writeFileSync(path.join(repoRoot, "README.md"), "# work\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: repoRoot });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repoRoot });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoRoot });
    // `repo` (owner/name) is read off the origin remote. The push that
    // follows a commit therefore fails, which is not what this test is about
    // — it asserts on what the second session was shown, and the commit port
    // keeps its commit and warns when it cannot push.
    execFileSync("git", ["remote", "set-url", "origin", "git@github.com:acme/api.git"], {
      cwd: repoRoot,
    });

    const projectDir = path.join(homeDir, ".claude", "projects", projectDirName(repoRoot));
    mkdirSync(projectDir, { recursive: true });
    const idle = new Date(Date.now() - IDLE_DAYS * 24 * 60 * 60 * 1000);
    for (const session of SESSIONS) {
      const transcriptPath = path.join(projectDir, `${session.id}.jsonl`);
      writeFileSync(transcriptPath, `${transcript(session.id, session.claim)}\n`, "utf8");
      utimesSync(transcriptPath, idle, idle);
    }

    config = resolveConfig({
      repoRoot,
      homeDir,
      repoFileContents: undefined,
      userFileContents: undefined,
      env: {
        SIGNPOSTS_RETRIEVAL_ALLOW_REMOTE_MODELS: "false",
        SIGNPOSTS_RETRIEVAL_LOCAL_MODEL_PATH: testLocalModelPath(),
      },
    });
    config = { ...config, paths: { ...config.paths, modelCacheDir: testModelCache() } };

    // `run` and `resume` refuse to spend tokens before this repo has
    // consented (src/cli/consent.ts) — the developer these tests stand in for
    // answered that once, in `init`.
    giveConsent(config, repoRoot);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function invoke(argv: string[]): Promise<RunOutput> {
    const stdio = createFakeStdio();
    const exitCode = await runCli(argv, { config, stdio });
    const output = JSON.parse(stdio.writtenOutput()) as RunOutput;
    // Two of the codes here are not failures (12-wire-contracts.md, "Exit
    // codes"), and this test is about what the second session retrieves, not
    // about which of them it got. So the expectation is derived from what the
    // invocation actually did: a halt only a person can answer is
    // `awaitingHuman`, and the push this setup deliberately breaks leaves the
    // commit on a branch with no pull request — `prCreationFailed`.
    // `sessions` prints a listing, which has no `pending` at all.
    const awaitingHuman = (output.pending ?? []).some(
      (pending) => !isModelRequest(pending.request),
    );
    const expected = awaitingHuman
      ? EXIT_CODES.awaitingHuman
      : stdio.writtenError().includes("could not push")
        ? EXIT_CODES.prCreationFailed
        : EXIT_CODES.ok;
    expect(exitCode, stdio.writtenError()).toBe(expected);
    return output;
  }

  /** Answers one halt the way the skill would, and continues the session. */
  async function answer(
    session: { id: string; contentHash: string },
    output: RunOutput,
    reply: (request: PendingRequest) => unknown,
  ): Promise<RunOutput> {
    const replies = Object.fromEntries(output.pending.map((pending) => [pending.id, reply(pending)]));
    writeFileSync(repliesPath, JSON.stringify({ replies }), "utf8");
    return invoke([
      "resume",
      "--session",
      session.id,
      "--content-hash",
      session.contentHash,
      "--replies",
      repliesPath,
    ]);
  }

  /**
   * Runs one session to completion, answering as the skill would: one
   * candidate, kept by the critic, classified against whatever neighbours
   * were retrieved, and every gated operation accepted.
   */
  async function runSession(
    session: { id: string; contentHash: string },
    claim: string,
  ): Promise<RunOutput> {
    let output = await invoke([
      "run",
      "--session",
      session.id,
      ...(session.id === SESSIONS[0]!.id ? ["--first"] : []),
    ]);

    while (output.status === "waiting") {
      output = await answer(session, output, (pending) => {
        if (!isModelRequest(pending.request)) {
          // A review: accept everything it is holding.
          const request = pending.request as { needsHuman: { operation: unknown }[] };
          return Object.fromEntries(
            request.needsHuman.map(({ operation }) => [
              operationKey(operation as Parameters<typeof operationKey>[0]),
              { decision: "accept", decidedAt: "2026-09-06" },
            ]),
          );
        }

        switch (pending.request.node) {
          case "extract":
            return {
              candidates: [
                {
                  tempId: "t1",
                  claim,
                  category: "environment",
                  scope: { repo: "acme/api" },
                  evidence: "The human corrected a migration run against staging.",
                  confidence: 0.9,
                  hedged: false,
                },
              ],
            };
          case "critic":
            return { verdicts: [{ tempId: "t1", keep: true, reason: "durable" }] };
          case "classify": {
            classifyTurns.push(pending.request.user);
            // The classifier reads its own input: a neighbour that is already
            // about this is a duplicate, nothing retrieved is novel.
            const relatedId = /"id":"([^"]+)"/.exec(pending.request.user)?.[1];
            return relatedId === undefined
              ? { tempId: "t1", kind: "NOVEL", rationale: "nothing recorded is about this" }
              : { tempId: "t1", kind: "DUPLICATE", relatedId, rationale: "the same lesson, reworded" };
          }
          default:
            throw new Error(`unexpected node ${pending.request.node}`);
        }
      });
    }

    return output;
  }

  it("shows the second session what the first proposed, so it reinforces instead of adding again", async () => {
    const listed = (await invoke(["sessions"])) as unknown as {
      sessions: { sessionId: string; contentHash: string }[];
    };
    const refs = SESSIONS.map((session) => {
      const found = listed.sessions.find((entry) => entry.sessionId === session.id);
      expect(found, `session ${session.id} was not listed`).toBeDefined();
      return { id: session.id, contentHash: found!.contentHash, claim: session.claim };
    });

    const first = await runSession(refs[0]!, refs[0]!.claim);
    const second = await runSession(refs[1]!, refs[1]!.claim);

    expect(first.proposed.join("\n")).toContain("add ");
    // The second session was shown the first session's proposal, flagged as
    // something a person has not merged yet.
    expect(classifyTurns.at(-1)).toContain(FIRST_CLAIM);
    expect(classifyTurns.at(-1)).toContain('"pending"');
    expect(second.proposed.join("\n")).toContain("reinforce ");
    expect(second.proposed.join("\n")).not.toContain("add ");
  }, 60_000);
});
