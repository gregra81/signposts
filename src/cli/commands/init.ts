// `signpost init` (R3): set this repo up now, and fetch the embedding model.
//
// Optional. The first `sessions`, `run` or `resume` does the same setup
// (../setup.ts), because a developer who has to type a setup command and
// answer a consent prompt before seeing the tool do anything mostly never
// does (19-value-to-a-user.md, "Fewer human steps"). What `init` adds is the
// model download, done here rather than inside the first run's first halt.
//
// It asks nothing and writes nothing into the checkout the team shares: the
// skill ships in the plugin, and the CLAUDE.md pointer arrives with the first
// signposts commit (src/io/commit/commit-port.ts).

import type { ExitCode, Stdio } from "../../app.ts";
import type { ResolvedConfig } from "../../core/config/resolve.ts";
import { setUpRepo } from "../setup.ts";

/**
 * Puts the embedding model on this machine, saying what it did through `say`.
 * Never throws — see src/io/embed/prefetch.ts, the production one.
 */
export type PrefetchModel = (config: ResolvedConfig, say: (line: string) => void) => Promise<void>;

export interface RunInitInput {
  config: ResolvedConfig;
  repoRoot: string;
  stdio: Stdio;
  /**
   * Absent in tests that are not about it: the real one downloads a model.
   * The composition root always passes it.
   */
  prefetchModel?: PrefetchModel;
}

export async function runInit({ config, repoRoot, stdio, prefetchModel }: RunInitInput): Promise<ExitCode> {
  const say = (line: string): void => {
    stdio.output.write(`signposts: ${line}\n`);
  };

  const outcome = setUpRepo({ config, repoRoot, say });
  if (outcome.status === "no-origin") {
    stdio.error.write(
      "signposts: could not determine repo (owner/name) from the 'origin' git remote — is this a git repo with a GitHub origin configured?\n",
    );
    return 1;
  }
  if (outcome.status === "failed") {
    stdio.error.write(`signposts: ${outcome.reason}\n`);
    return 1;
  }

  // "a run" and "a session that has gone quiet" are this repo's words, not a
  // developer's. Say what they will see happen, and where it ends up.
  //
  // "clear or close" rather than "goes idle": a session Claude Code said had
  // ended is eligible with no wait, so `/clear` brings the offer up in the same
  // window. Falling quiet without ending still waits IDLE_HOURS, which is the
  // slow path and not worth a sentence here.
  say("ready. When you clear or close a Claude conversation here, Claude offers to write up what you worked out in it and open a pull request.");
  await prefetchModel?.(config, say);
  return 0;
}
