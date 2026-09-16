// `signpost sessions`, `signpost run` and `signpost resume` end to end: a real
// transcript on disk, a real repository, the real database and embedder, and
// the graph halting for an answer.
//
// This is the loop the skill drives, so it is tested the way the skill uses
// it — one JSON object per invocation, answers keyed by pending id, and each
// command its own process' worth of work with nothing carried in memory
// between them.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig, type ResolvedConfig } from "../../../src/core/config/resolve.js";
import { projectDirName } from "../../../src/core/transcript/project-dir.js";
import { runCli } from "../helpers/run-cli.js";
import { giveConsent } from "../helpers/consent.js";
import { createFakeStdio } from "../helpers/fake-stdio.js";
import { testLocalModelPath, testModelCache } from "../../support/model-cache.js";
import { MODEL_REQUEST_KIND } from "../../../src/graph/index.js";

const SESSION_ID = "01J9FSESSION";
const AUTHOR = "greg@example.com";
const IDLE_DAYS = 3;

/**
 * A transcript whose human turns are corrections worth extracting, and long
 * enough to clear MIN_GUTTERED_TOKENS — a session under that is skipped
 * before any model call, which is the gutter doing its job.
 */
function transcript(): string {
  const base = {
    uuid: "u1",
    parentUuid: null,
    sessionId: SESSION_ID,
    timestamp: "2026-08-01T09:00:00Z",
    cwd: "/repo",
    gitBranch: "main",
    isSidechain: false,
  };
  const exchanges = [
    [
      "I will run the pending migration against the staging database now, and then verify the schema.",
      "No — staging is read only outside the ETL window, which runs 02:00 to 04:00 UTC every night. Run migrations against dev instead, and let the nightly job carry them to staging.",
    ],
    [
      "Understood. I will point the migration at dev and re-run the verification against staging afterwards.",
      "That works. Remember the permissions error you saw is what a read-only replica looks like — it is not a connection problem, so do not go looking at the network configuration again.",
    ],
    [
      "Should I also update the seed script so it targets dev by default?",
      "Yes, and never add a write path to staging in any script here. Every write must go through the ETL job, which is the only thing with credentials for the writable instance.",
    ],
    [
      "I will add a check to the deploy script that refuses a staging write outside the window.",
      "Do not put that check in the deploy script — it belongs in the migration runner, because the deploy script is generated from the terraform module and your change would be overwritten on the next plan.",
    ],
    [
      "Then I will regenerate the terraform module with the check built in.",
      "No. The terraform module is owned by the platform team and we do not fork it. Raise it with them if the runner check is not enough; meanwhile the runner check is what we ship.",
    ],
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
        // wearing a user hat — see src/core/transcript/classify.ts.
        origin: { kind: "human" },
        message: { role: "user", content: human },
      }),
    ])
    .join("\n");
}

function firstJson(output: string): Record<string, unknown> {
  return JSON.parse(output) as Record<string, unknown>;
}

describe("the run loop", () => {
  let root: string;
  let homeDir: string;
  let repoRoot: string;
  let config: ResolvedConfig;
  let repliesPath: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "signposts-run-"));
    homeDir = path.join(root, "home");
    repoRoot = path.join(root, "checkout");
    repliesPath = path.join(root, "replies.json");
    mkdirSync(homeDir, { recursive: true });

    const remote = path.join(root, "remote.git");
    execFileSync("git", ["init", "--bare", "--initial-branch=main", remote]);
    execFileSync("git", ["clone", remote, repoRoot]);
    execFileSync("git", ["config", "user.email", AUTHOR], { cwd: repoRoot });
    execFileSync("git", ["config", "user.name", "Greg"], { cwd: repoRoot });
    execFileSync("git", ["remote", "set-url", "origin", "git@github.com:acme/api.git"], { cwd: repoRoot });

    // The transcript, in the directory Claude Code would have written it to,
    // last touched long enough ago to clear the idle gate.
    const projectDir = path.join(homeDir, ".claude", "projects", projectDirName(repoRoot));
    mkdirSync(projectDir, { recursive: true });
    const transcriptPath = path.join(projectDir, `${SESSION_ID}.jsonl`);
    writeFileSync(transcriptPath, `${transcript()}\n`, "utf8");
    const idle = new Date(Date.now() - IDLE_DAYS * 24 * 60 * 60 * 1000);
    utimesSync(transcriptPath, idle, idle);

    config = resolveConfig({
      repoRoot,
      homeDir,
      repoFileContents: undefined,
      userFileContents: undefined,
      // The suite runs with the network denied, so the embedder must read the
      // model the global setup put on disk.
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

  it("lists the eligible session", async () => {
    const stdio = createFakeStdio();

    const exitCode = await runCli(["sessions"], { config, stdio });

    expect(exitCode).toBe(0);
    const output = firstJson(stdio.writtenOutput()) as { sessions: { sessionId: string }[] };
    expect(output.sessions.map((session) => session.sessionId)).toEqual([SESSION_ID]);
  });

  // 19-value-to-a-user.md item 1, through the production seam: the real gutter,
  // the real `sessions` table, and the real `eligible` that reads it back.
  it("skips an empty transcript once, and never offers it again", async () => {
    const empty = "01J9FEMPTY";
    const emptyPath = path.join(homeDir, ".claude", "projects", projectDirName(repoRoot), `${empty}.jsonl`);
    writeFileSync(emptyPath, "", "utf8");
    const idle = new Date(Date.now() - IDLE_DAYS * 24 * 60 * 60 * 1000);
    utimesSync(emptyPath, idle, idle);

    const ran = createFakeStdio();
    const exitCode = await runCli(["run", "--session", empty], { config, stdio: ran });

    expect(exitCode).toBe(0);
    expect(firstJson(ran.writtenOutput())).toMatchObject({
      sessionId: empty,
      status: "skipped",
      reason: expect.stringContaining("no usable transcript lines"),
    });

    const listed = createFakeStdio();
    await runCli(["sessions"], { config, stdio: listed });
    const { sessions } = firstJson(listed.writtenOutput()) as { sessions: { sessionId: string }[] };
    expect(sessions.map((session) => session.sessionId)).toEqual([SESSION_ID]);
  }, 30_000);

  it("halts on the first model call, carrying everything needed to answer it", async () => {
    const stdio = createFakeStdio();

    const exitCode = await runCli(["run", "--first"], { config, stdio });

    expect(exitCode).toBe(0);
    const output = firstJson(stdio.writtenOutput()) as {
      sessionId: string;
      status: string;
      pending: { id: string; request: { kind: string; node: string; system: string; user: string; schema: unknown } }[];
    };
    expect(output.sessionId).toBe(SESSION_ID);
    expect(output.status).toBe("waiting");
    expect(output.pending).toHaveLength(1);

    const [pending] = output.pending;
    expect(pending?.request.kind).toBe(MODEL_REQUEST_KIND);
    expect(pending?.request.node).toBe("extract");
    expect(pending?.request.system).toContain("signpost");
    // The guttered transcript is what it is being asked about.
    expect(pending?.request.user).toContain("staging is read only");
    expect(pending?.request.schema).toBeTypeOf("object");
  }, 30_000);

  it("takes the answer and halts on the next question", async () => {
    const started = createFakeStdio();
    await runCli(["run", "--first"], { config, stdio: started });
    const { pending } = firstJson(started.writtenOutput()) as { pending: { id: string }[] };

    writeFileSync(
      repliesPath,
      JSON.stringify({
        replies: {
          [pending[0]!.id]: {
            candidates: [
              {
                tempId: "t1",
                claim: "Staging is read only outside the ETL window",
                category: "environment",
                scope: { repo: "acme/api" },
                evidence: "A migration against staging was refused.",
                confidence: 0.9,
                hedged: false,
              },
            ],
          },
        },
      }),
      "utf8",
    );

    const stdio = createFakeStdio();
    const exitCode = await runCli(
      ["resume", "--session", SESSION_ID, "--replies", repliesPath],
      { config, stdio },
    );

    expect(exitCode).toBe(0);
    const output = firstJson(stdio.writtenOutput()) as {
      status: string;
      pending: { request: { node: string } }[];
    };
    expect(output.status).toBe("waiting");
    expect(output.pending[0]?.request.node).toBe("critic");
  }, 30_000);

  it("refuses an answer of the wrong shape rather than carrying it into the graph", async () => {
    const started = createFakeStdio();
    await runCli(["run", "--first"], { config, stdio: started });
    const { pending } = firstJson(started.writtenOutput()) as { pending: { id: string }[] };
    writeFileSync(repliesPath, JSON.stringify({ replies: { [pending[0]!.id]: { candidates: [{}] } } }), "utf8");

    // The schema violation is reported, not thrown past the CLI: the skill is
    // told every command prints one JSON object, so a rejected answer has to
    // reach it as `signposts: <message>` and a non-zero exit — something it
    // can tell apart from a crash — with stdout left empty rather than
    // carrying a half-written object.
    const stdio = createFakeStdio();
    const exitCode = await runCli(
      ["resume", "--session", SESSION_ID, "--replies", repliesPath],
      { config, stdio },
    );

    expect(exitCode).toBe(1);
    expect(stdio.writtenError()).toMatch(/extract: structured output did not satisfy its schema/);
    expect(stdio.writtenOutput()).toBe("");
  }, 30_000);

  // 15-spec.md story 71: everything manually and verbosely, without the
  // plugin. Nothing here goes through a hook, a worker or the skill — it is
  // the CLI a person types, and the trace is what tells them what it did.
  it("--verbose narrates the run on stderr, and leaves stdout one JSON object", async () => {
    const stdio = createFakeStdio();

    const exitCode = await runCli(["run", "--first", "--verbose"], { config, stdio });

    expect(exitCode).toBe(0);
    const trace = stdio.writtenError();
    expect(trace).toContain("repo acme/api");
    expect(trace).toContain(`running session ${SESSION_ID}`);
    expect(trace).toContain("halted on 1 request(s)");
    // The command a person types next, with both halves of the thread id
    // already filled in — retyping them out of the JSON is where a manual run
    // goes wrong.
    const output = firstJson(stdio.writtenOutput()) as { contentHash: string };
    expect(trace).toContain(`--session ${SESSION_ID} --content-hash ${output.contentHash}`);
  }, 30_000);

  it("says nothing on stderr without --verbose", async () => {
    const stdio = createFakeStdio();

    await runCli(["run", "--first"], { config, stdio });

    expect(stdio.writtenError()).toBe("");
  }, 30_000);
});
