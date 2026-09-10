// The two facts that stop the loop outright, measured where a person can see
// them (18-end-to-end-gaps.md, item 7).
//
// `git config user.email` unset makes `sessions`, `run` and `resume` exit 1;
// no `origin` — or one yielding no `owner/name` — makes `init` and `index` do
// the same. Both messages are good when they arrive. They arrive from the
// wrong command, on a fresh container or a new machine, which is precisely
// where `doctor` is the one someone runs first.

import type { GitFacts } from "../../core/doctor/report.ts";
import { resolveRepo } from "../git/remote-origin.ts";
import { authorEmail } from "../git/worktree.ts";

export function checkGitFacts(repoRoot: string): GitFacts {
  return { authorEmail: authorEmail(repoRoot), repo: resolveRepo(repoRoot) };
}
