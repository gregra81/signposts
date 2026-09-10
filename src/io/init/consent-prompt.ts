// First-run consent prompt (R3): plain stdin/stdout, deliberately not a
// port — 15-spec.md's three ports are model/clock/forge only, and asking
// once via the terminal is not something a test needs to fake at the port
// level, just feed via a stream. src/core/init/policy.ts's
// parseConsentAnswer decides what the typed answer means; this module only
// does the prompting.
//
// The text answers the three questions 15-spec.md's story 70 names — what it
// does, roughly what it costs, where the output goes — because the whole
// point of the gate is that unexplained spend is never how a developer finds
// out the tool is running. A prompt that says only "continue?" is the README
// paragraph the story rejects, moved into the terminal.

import { createInterface } from "node:readline";

export const CONSENT_PROMPT_TEXT = `signposts turns your Claude Code transcripts into reviewed team knowledge.

  What it does   Reads this machine's Claude Code transcripts for this repo, once they have
                 been idle a while, and distils what you learned into signposts.
  What it costs  The reasoning is model calls answered by your own Claude Code session — a
                 handful per transcript, on the same plan and quota as your interactive work.
                 Retrieval and indexing are local and free.
  Where it goes  Proposals are committed through a separate worktree onto a signposts/<you>/<date>
                 branch and opened as a pull request. Your working tree is never touched. Local
                 state (database, index, model cache) lives under ~/.signposts/.

This is asked once. Continue? [y/N] `;

export interface ConsentIO {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

/**
 * Prints CONSENT_PROMPT_TEXT and returns the raw line the user typed. If
 * stdin hits EOF with no answer (piped/non-TTY/CI), `rl.question()` never
 * resolves on its own — treat that as an empty answer, which
 * parseConsentAnswer already reads as decline.
 */
export async function promptForConsent(io: ConsentIO): Promise<string> {
  const rl = createInterface({ input: io.input, output: io.output });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(CONSENT_PROMPT_TEXT, (answer) => resolve(answer));
      rl.on("close", () => resolve(""));
    });
  } finally {
    rl.close();
  }
}
