// First-run consent prompt (R3): plain stdin/stdout, deliberately not a
// port — 15-spec.md's three ports are model/clock/forge only, and asking
// once via the terminal is not something a test needs to fake at the port
// level, just feed via a stream. src/core/init/policy.ts's
// parseConsentAnswer decides what the typed answer means; this module only
// does the prompting.

import { createInterface } from "node:readline";

export const CONSENT_PROMPT_TEXT =
  "signposts reads Claude Code transcripts on this machine, spends your Anthropic API " +
  "credits to propose knowledge for review, and writes proposals to a branch/PR in this " +
  "repo. This is asked once. Continue? [y/N] ";

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
