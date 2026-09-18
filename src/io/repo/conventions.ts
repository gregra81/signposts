// The repo's own conventions file, for the `critic` to judge candidates
// against (14-prompts.md, "critic"; 19-value-to-a-user.md's critic-precision
// follow-up).
//
// A claim the repository already writes down is not new, and the critic's
// first reject rule has said so since it was written — it just had no way to
// check, seeing candidates and nothing else. Measured over the golden set,
// handing it this file cut the candidates kept on sessions that should produce
// nothing from 9 of 24 to 4 of 24, with expected claims unchanged.
//
// Truncated rather than summarised: this rides on every critic call, and a
// summary is another model call to pay for and to be wrong.

import { readFileSync } from "node:fs";
import path from "node:path";
import { CONVENTIONS_FILENAME, CRITIC_CONVENTIONS_MAX_CHARS } from "../../core/config/constants.ts";

/** `repoRoot`'s CLAUDE.md, capped, or null when there is none to read. */
export function readConventions(repoRoot: string): string | null {
  try {
    const text = readFileSync(path.join(repoRoot, CONVENTIONS_FILENAME), "utf8");
    return text === "" ? null : text.slice(0, CRITIC_CONVENTIONS_MAX_CHARS);
  } catch {
    return null; // No file, or unreadable: the critic judges the candidates alone.
  }
}
