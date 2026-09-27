// Decision logic for setting a repo up (15-spec.md user stories 60/70, R3):
// whether it has been set up, and what the CLAUDE.md pointer becomes. All
// pure — persistence is the caller's job (src/cli/initialise.ts,
// src/io/commit/commit-port.ts, src/io/init/*).
//
// There used to be a consent prompt here, typed at `signpost init`. It went
// because nobody types a setup command for a tool they have not seen work:
// saying yes to the session's offer to run is the consent now, and the first
// run sets the repo up (19-value-to-a-user.md, "Fewer human steps").

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
 * Whether this repo already has consent on file. Both inputs are needed:
 * a db file can exist without a consented row (e.g. only bootstrap ran),
 * and there's no row at all to check when the db file was never created.
 */
export function isConsented(dbFileExists: boolean, rowConsented: boolean): boolean {
  return dbFileExists && rowConsented;
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
