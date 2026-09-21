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
//      [--only current|candidate]
//
// It spends subscription tokens: runs × prompts × conditions sessions.

import { spawnSync } from "node:child_process";
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
 * The wordings under test. `current` is whatever the hook ships today, read
 * from the hook itself so this cannot drift from it.
 */
const CURRENT = contextFor(REASONS);

// Where the shipped wording's instruction begins. The candidate keeps the
// census sentence in front of it word for word and replaces only the
// instruction, so the two conditions differ in one thing. A throw here means
// the hook's wording moved and this script is measuring the wrong contrast.
const INSTRUCTION_START = "Offer this to the developer";
if (!CURRENT.includes(INSTRUCTION_START)) {
  throw new Error(`the hook's instruction no longer starts with "${INSTRUCTION_START}"`);
}

const CANDIDATE =
  CURRENT.slice(0, CURRENT.indexOf(INSTRUCTION_START)) +
  "Ask the developer about this before anything else in this session: before your first tool call " +
  "and before starting what they asked for. Put it in one sentence, then end your turn and wait for " +
  "their answer — a run spends this session's tokens, so it is theirs to start. On a yes, drive it " +
  "with the signposts skill. On a no, drop it and do not raise it again this session.";

const WORDINGS = {
  current: CURRENT,
  candidate: CANDIDATE,
};

// The three first prompts of the original measurement: a question, an edit and
// a rename. The question is answerable without touching a file, so a run that
// answers it first has not disobeyed anything; the other two are where "before
// their next task" has teeth.
const PROMPTS = [
  "What does this repo do?",
  "Add a function that formats a duration in seconds as `1m 30s` to src/format.js.",
  "Rename `total` to `sum` in src/total.js.",
];

/**
 * A repo with two files, a git dir, and a hook that prints one wording.
 * @param {string} workspace @param {string} name @param {string} context
 */
function makeRepo(workspace, name, context) {
  const repoRoot = path.join(workspace, name);
  mkdirSync(path.join(repoRoot, "src"), { recursive: true });
  mkdirSync(path.join(repoRoot, ".claude"), { recursive: true });
  writeFileSync(path.join(repoRoot, "src", "total.js"), "export const total = (xs) => xs.reduce((a, b) => a + b, 0);\n");
  writeFileSync(path.join(repoRoot, "src", "format.js"), "export const pad = (n) => String(n).padStart(2, \"0\");\n");
  spawnSync("git", ["init", "-q"], { cwd: repoRoot });

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
 * Events in the order Claude produced them.
 * @param {string} stdout
 * @returns {{kind: "text" | "tool", value: string}[]}
 */
function eventsOf(stdout) {
  /** @type {{kind: "text" | "tool", value: string}[]} */
  const events = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.type !== "assistant") continue;
    for (const block of parsed.message?.content ?? []) {
      if (block.type === "text") events.push({ kind: "text", value: block.text });
      if (block.type === "tool_use") events.push({ kind: "tool", value: block.name });
    }
  }
  return events;
}

const MENTIONS_OFFER = /signpost run|signposts skill|distil|team knowledge/i;

/** @param {{kind: "text" | "tool", value: string}[]} events */
function score(events) {
  const offerAt = events.findIndex((e) => e.kind === "text" && MENTIONS_OFFER.test(e.value));
  const toolAt = events.findIndex((e) => e.kind === "tool");
  const firstText = events.findIndex((e) => e.kind === "text");
  return {
    offered: offerAt !== -1,
    askedFirst: offerAt !== -1 && offerAt === firstText && (toolAt === -1 || toolAt > offerAt),
    actedFirst: offerAt !== -1 && toolAt !== -1 && toolAt < offerAt,
  };
}

/**
 * @param {string} workspace @param {string} label @param {string} context
 * @param {string} prompt @param {number} i
 * @returns {{failed?: string, offered?: boolean, askedFirst?: boolean, actedFirst?: boolean}}
 */
function runOnce(workspace, label, context, prompt, i) {
  const repoRoot = makeRepo(workspace, `${label}-${i}`, context);
  const result = spawnSync(
    "claude",
    [
      "-p",
      prompt,
      "--model",
      MODEL,
      "--setting-sources",
      "project",
      "--no-session-persistence",
      "--output-format",
      "stream-json",
      "--verbose",
    ],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    return { failed: (result.stderr || "").trim().slice(0, 200) };
  }
  return score(eventsOf(result.stdout));
}

const workspace = mkdtempSync(path.join(tmpdir(), "signposts-offer-"));
process.on("exit", () => rmSync(workspace, { recursive: true, force: true }));

console.log(`model ${MODEL}, ${RUNS} run(s) × ${PROMPTS.length} prompt(s) per wording\n`);

for (const [label, context] of Object.entries(WORDINGS)) {
  if (context === null || (ONLY !== null && ONLY !== label)) continue;
  /** @type {{prompt: string, failed?: string, offered?: boolean, askedFirst?: boolean, actedFirst?: boolean}[]} */
  const rows = [];
  for (const prompt of PROMPTS) {
    for (let i = 0; i < RUNS; i += 1) {
      const row = runOnce(workspace, label, context, prompt, rows.length);
      rows.push({ prompt, ...row });
      process.stdout.write(row.failed ? "!" : row.askedFirst ? "A" : row.offered ? "o" : ".");
    }
  }
  const n = rows.filter((r) => !r.failed).length;
  /** @type {(key: "offered" | "askedFirst" | "actedFirst") => number} */
  const count = (key) => rows.filter((r) => r[key] === true).length;
  console.log(`\n\n${label}`);
  console.log(`  offered            ${count("offered")}/${n}`);
  console.log(`  asked before doing ${count("askedFirst")}/${n}`);
  console.log(`  acted first        ${count("actedFirst")}/${n}`);
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
