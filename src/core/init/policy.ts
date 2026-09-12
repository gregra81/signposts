// Decision logic for `signpost init` (15-spec.md user stories 60/70, R3):
// whether a first-run consent prompt is needed, what a typed answer means,
// what exit code a decision produces, and whether the CLAUDE.md pointer
// still needs appending. All pure — persistence and prompting are the
// caller's job (src/cli/commands/init.ts, src/io/init/*).

/**
 * Block from 03-memory-model.md "The CLAUDE.md pointer", appended once on first run.
 *
 * `index.md` is named conditionally, because on the repo this is written into it
 * does not exist yet and will not for a while. It is generated output with one
 * writer — `writeCorpus`, inside the commit worktree — so it reaches the checkout
 * with the first merged pull request and not before (src/cli/commands/index.ts
 * explains why nothing else may create it). An unconditional pointer sends every
 * fresh repo to a missing file, which reads as a broken install and invites the
 * developer to fix something that is working.
 */
export const CLAUDE_MD_POINTER = `## Team knowledge

This repo carries hard-won team knowledge as markdown in \`.signposts/\`. Before starting
work — especially anything touching infrastructure, migrations, or deployment — read any
signpost whose scope matches the files you're changing. Once \`.signposts/index.md\` is
there, it tables every active claim and is the place to start. These are things you cannot
infer from the code.
`;

/**
 * What a token-spending command says when this repo has never consented.
 *
 * Consent is a gate, not a paragraph in the README (15-spec.md story 70), and
 * it has to hold on the manual path too: `run` and `resume` are typed by hand
 * as often as they are driven by the skill, and neither goes anywhere near
 * `init`. They refuse rather than prompt because they are answered by a
 * subagent through one JSON object per invocation — a question asked there is
 * a question asked of nobody, which is the same reason `review` refuses a
 * pipe.
 */
export const CONSENT_REQUIRED_MESSAGE =
  "this repo has not consented to signposts running. Run `signpost init` — it says what the " +
  "tool does, what it costs and where its output goes, and asks once.";

/** An already-consented repo's `init` re-run is a no-op — no prompt, nothing written. */
export function needsConsentPrompt(hasConsented: boolean): boolean {
  return !hasConsented;
}

/**
 * Whether this repo already has consent on file. Both inputs are needed:
 * a db file can exist without a consented row (e.g. only bootstrap ran),
 * and there's no row at all to check when the db file was never created.
 */
export function isConsented(dbFileExists: boolean, rowConsented: boolean): boolean {
  return dbFileExists && rowConsented;
}

/** y/yes (any case, surrounding whitespace ignored) is acceptance; everything else is a decline. */
export function parseConsentAnswer(raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

/** Consenting exits 0 and persists; declining exits 1 and persists nothing (R3). */
export function consentExitCode(accepted: boolean): 0 | 1 {
  return accepted ? 0 : 1;
}

export interface ClaudeMdUpdate {
  content: string;
  changed: boolean;
}

/**
 * Idempotent: if `existing` already carries the pointer block, returns it
 * unchanged. Otherwise appends the pointer, separated from any existing
 * content by a blank line.
 */
export function ensureClaudeMdPointer(existing: string | undefined): ClaudeMdUpdate {
  if (existing !== undefined && existing.includes(CLAUDE_MD_POINTER)) {
    return { content: existing, changed: false };
  }

  if (existing === undefined || existing.length === 0) {
    return { content: CLAUDE_MD_POINTER, changed: true };
  }

  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  return { content: `${existing}${separator}${CLAUDE_MD_POINTER}`, changed: true };
}
