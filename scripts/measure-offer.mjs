// @ts-check
// Does Claude make the offer before doing the developer's task, or after?
//
// 19-value-to-a-user.md, "Follow-up: does Claude offer the run?": the offer
// reaches the developer in 17 of 18 headless runs, but "before their next task
// and wait" is followed in about a third. More often it is the last paragraph
// under finished work, which is the easiest place to skip. That measurement was
// made by hand and thrown away; this is the same method, committed, so a
// wording change can be judged rather than argued.
//
// Method, as close to the original as a script can get:
//
//   - a synthetic two-file repo per run, with its own `.claude/settings.json`
//     holding a SessionStart hook that prints one wording's `additionalContext`
//   - `--setting-sources project`, so an installed plugin or a user-level hook
//     on this machine cannot reach the run
//   - `--no-session-persistence`, so the probe leaves no transcript behind to
//     become an eligible session of its own
//   - default permissions, so an edit is denied the way it was then: a run that
//     tries the task first is visible rather than silently successful
//
// Scored off the stream, per run:
//
//   offered     any assistant text mentions the run or the skill
//   asked first the offer is in the FIRST assistant text, and no tool call came
//               before it — which is what the wording asks for
//   acted first a tool call or an edit happened before any offer
//
// Run: node scripts/measure-offer.mjs [--runs N] [--model sonnet|opus]
//      [--only plain|claude-md|multi-turn]
//
// It spends subscription tokens: runs × prompts × conditions sessions.
//
// `raised after a no` is multi-turn only: the offer mentioned again in a later
// turn, after the developer declined it. The wording says it must not be.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { contextFor } = await import(path.join(ROOT, "hooks", "session-start.ts"));

const argv = process.argv.slice(2);
/** @type {(name: string, fallback: string | null) => string | null} */
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : (argv[i + 1] ?? fallback);
};
const RUNS = Number(flag("--runs", "3"));
const MODEL = String(flag("--model", "sonnet"));
const ONLY = flag("--only", null);

/** The census the hook would have taken: a backlog and nothing parked. */
const REASONS = { sessions: 3, threads: 0, staleIndex: false, running: false };

/**
 * The wording the hook ships, read from the hook itself so this cannot drift
 * from it. The contrast this script was written for — the old "offer this
 * before their next task" against today's "ask before anything else" — was
 * settled on 2026-09-21 and the new wording shipped, so what is measured now
 * is that one wording under the conditions the headless probe left out
 * (19-value-to-a-user.md, open item 6).
 */
const CONTEXT = contextFor(REASONS);
if (!/before anything else/.test(CONTEXT)) {
  throw new Error("the hook's instruction no longer says \"before anything else\" — re-read what it ships");
}

// The three first prompts of the original measurement: a question, an edit and
// a rename. The question is answerable without touching a file, so a run that
// answers it first has not disobeyed anything; the other two are where "before
// anything else" has teeth.
const PROMPTS = [
  "What does this repo do?",
  "Add a function that formats a duration in seconds as `1m 30s` to src/format.js.",
  "Rename `total` to `sum` in src/total.js.",
];

/**
 * A repo whose own CLAUDE.md wants the first move too — the case a
 * single-turn probe in an empty repo cannot show.
 */
const COMPETING_CLAUDE_MD =
  "# Project rules\n\nAt the start of every session, before anything else, run `npm test` and report the result.\n";

/** What the developer says after the offer, and the task after that. */
const DECLINE = "No, not now. Just do what I asked.";
const NEXT_TASK = "Now rename `pad` to `padTwo` in src/format.js.";

/**
 * The conditions. `plain` is the original single-turn probe; `claude-md` adds
 * the competing file; `multi-turn` answers the offer with a no and gives one
 * more task, in one process, so the SessionStart hook fires once as it does in
 * a real session. The wording says "on a no, drop it and do not raise it again
 * this session", and only a second turn can show whether that holds.
 */
const CONDITIONS = {
  plain: { claudeMd: null, followUps: [] },
  "claude-md": { claudeMd: COMPETING_CLAUDE_MD, followUps: [] },
  "multi-turn": { claudeMd: null, followUps: [DECLINE, NEXT_TASK] },
};

/**
 * A repo with two files, a git dir, a hook that prints the wording, and
 * optionally a CLAUDE.md of its own.
 * @param {string} workspace @param {string} name @param {string} context @param {string | null} claudeMd
 */
function makeRepo(workspace, name, context, claudeMd) {
  const repoRoot = path.join(workspace, name);
  mkdirSync(path.join(repoRoot, "src"), { recursive: true });
  mkdirSync(path.join(repoRoot, ".claude"), { recursive: true });
  writeFileSync(path.join(repoRoot, "src", "total.js"), "export const total = (xs) => xs.reduce((a, b) => a + b, 0);\n");
  writeFileSync(path.join(repoRoot, "src", "format.js"), "export const pad = (n) => String(n).padStart(2, \"0\");\n");
  spawnSync("git", ["init", "-q"], { cwd: repoRoot });
  if (claudeMd !== null) writeFileSync(path.join(repoRoot, "CLAUDE.md"), claudeMd);

  // The hook is a file rather than an inline -e, so the JSON never goes
  // through a shell that would have to quote it.
  const hook = path.join(repoRoot, ".claude", "offer-hook.mjs");
  const payload = JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
  });
  writeFileSync(hook, `console.log(${JSON.stringify(payload)});\n`);
  writeFileSync(
    path.join(repoRoot, ".claude", "settings.json"),
    `${JSON.stringify(
      {
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: `node ${hook}` }] }],
        },
      },
      null,
      2,
    )}\n`,
  );
  return repoRoot;
}

/**
 * Events in the order Claude produced them, each tagged with the turn it
 * belongs to. A `result` line closes a turn.
 * @param {string} stdout
 * @returns {{kind: "text" | "tool", value: string, turn: number}[]}
 */
function eventsOf(stdout) {
  /** @type {{kind: "text" | "tool", value: string, turn: number}[]} */
  const events = [];
  let turn = 0;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.type === "result") {
      turn += 1;
      continue;
    }
    if (parsed.type !== "assistant") continue;
    for (const block of parsed.message?.content ?? []) {
      if (block.type === "text") events.push({ kind: "text", value: block.text, turn });
      if (block.type === "tool_use") events.push({ kind: "tool", value: block.name, turn });
    }
  }
  return events;
}

const MENTIONS_OFFER = /signpost run|signposts skill|distil|team knowledge/i;

/** @param {{kind: "text" | "tool", value: string, turn: number}[]} all */
function score(all) {
  // The offer belongs to the first turn; later turns are only asked whether
  // it came back after the developer said no.
  const events = all.filter((e) => e.turn === 0);
  const offerAt = events.findIndex((e) => e.kind === "text" && MENTIONS_OFFER.test(e.value));
  const toolAt = events.findIndex((e) => e.kind === "tool");
  const firstText = events.findIndex((e) => e.kind === "text");
  return {
    offered: offerAt !== -1,
    askedFirst: offerAt !== -1 && offerAt === firstText && (toolAt === -1 || toolAt > offerAt),
    actedFirst: offerAt !== -1 && toolAt !== -1 && toolAt < offerAt,
    raisedAgain: all.some((e) => e.turn > 0 && e.kind === "text" && MENTIONS_OFFER.test(e.value)),
    // How many turns said anything. A multi-turn session whose later messages
    // were merged into the first shows 1 here, and its `raisedAgain` means
    // nothing — which is how the first version of this measured nothing.
    turns: new Set(all.map((e) => e.turn)).size,
  };
}

/**
 * One session: the first prompt, then each follow-up once the turn before it
 * has finished, all on one process's stdin as stream-json. Queued up front,
 * they are merged into the first turn — the model sees the question, the "no"
 * and the next task at once, and there is no later turn for the offer to come
 * back in. A resume instead would fire SessionStart again and hand the
 * wording back.
 * @param {string} workspace @param {string} label @param {{claudeMd: string | null, followUps: string[]}} condition
 * @param {string} prompt @param {number} i
 * @returns {Promise<{failed?: string, offered?: boolean, askedFirst?: boolean, actedFirst?: boolean, raisedAgain?: boolean, turns?: number}>}
 */
function runOnce(workspace, label, condition, prompt, i) {
  const repoRoot = makeRepo(workspace, `${label}-${i}`, CONTEXT, condition.claudeMd);
  const messages = [prompt, ...condition.followUps];
  const line = (/** @type {string} */ content) =>
    `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;

  return new Promise((resolve) => {
    const child = spawn(
      "claude",
      [
        "-p",
        "--input-format",
        "stream-json",
        "--model",
        MODEL,
        "--setting-sources",
        "project",
        "--no-session-persistence",
        "--output-format",
        "stream-json",
        "--verbose",
      ],
      { cwd: repoRoot },
    );
    let stdout = "";
    let stderr = "";
    let sent = 0;
    const next = () => {
      const message = messages[sent];
      sent += 1;
      if (message === undefined) {
        child.stdin.end();
      } else {
        child.stdin.write(line(message));
      }
    };
    let turnsDone = 0;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      // A turn is over when its `result` line has arrived whole; only then is
      // the next message the developer's reply to it.
      const complete = stdout.slice(0, stdout.lastIndexOf("\n") + 1);
      const results = complete.split("\n").filter((l) => l.includes('"type":"result"')).length;
      while (turnsDone < results) {
        turnsDone += 1;
        next();
      }
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => {
      resolve(status === 0 ? score(eventsOf(stdout)) : { failed: stderr.trim().slice(0, 200) });
    });
    next();
  });
}

const workspace = mkdtempSync(path.join(tmpdir(), "signposts-offer-"));
process.on("exit", () => rmSync(workspace, { recursive: true, force: true }));

console.log(`model ${MODEL}, ${RUNS} run(s) × ${PROMPTS.length} prompt(s) per condition\n`);

for (const [label, condition] of Object.entries(CONDITIONS)) {
  if (ONLY !== null && ONLY !== label) continue;
  /** @type {{prompt: string, failed?: string, offered?: boolean, askedFirst?: boolean, actedFirst?: boolean, raisedAgain?: boolean, turns?: number}[]} */
  const rows = [];
  for (const prompt of PROMPTS) {
    for (let i = 0; i < RUNS; i += 1) {
      const row = await runOnce(workspace, label, condition, prompt, rows.length);
      rows.push({ prompt, ...row });
      process.stdout.write(row.failed ? "!" : row.askedFirst ? "A" : row.offered ? "o" : ".");
    }
  }
  const n = rows.filter((r) => !r.failed).length;
  /** @type {(key: "offered" | "askedFirst" | "actedFirst" | "raisedAgain") => number} */
  const count = (key) => rows.filter((r) => r[key] === true).length;
  console.log(`\n\n${label}`);
  console.log(`  offered            ${count("offered")}/${n}`);
  console.log(`  asked before doing ${count("askedFirst")}/${n}`);
  console.log(`  acted first        ${count("actedFirst")}/${n}`);
  if (condition.followUps.length > 0) {
    const whole = rows.filter((r) => r.turns === 1 + condition.followUps.length).length;
    console.log(`  every turn ran     ${whole}/${n}`);
    console.log(`  raised after a no  ${count("raisedAgain")}/${n}`);
  }
  const failed = rows.filter((r) => r.failed);
  if (failed.length > 0) console.log(`  failed             ${failed.length} (${failed[0]?.failed ?? ""})`);
  for (const prompt of PROMPTS) {
    const set = rows.filter((r) => r.prompt === prompt && !r.failed);
    console.log(
      `    ${prompt.slice(0, 48).padEnd(50)} asked first ${set.filter((r) => r.askedFirst).length}/${set.length}`,
    );
  }
  console.log("");
}
