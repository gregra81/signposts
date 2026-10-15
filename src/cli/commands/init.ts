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
//
// It is also where a checkout's storage is chosen: `--personal` keeps what its
// runs find on this machine, `--repo` puts it back on the pull request. The
// choice goes into the checkout's state directory, not the repo, and not
// ~/.signposts/config.yaml, because it is one developer's and one repo's.
// Without either flag, init leaves whatever was chosen before.

import type { ExitCode, Stdio } from "../../app.ts";
import { STORAGE_PERSONAL } from "../../core/config/constants.ts";
import { withStorage, type ResolvedConfig } from "../../core/config/resolve.ts";
import type { CommandOptions } from "../../core/cli/dispatch.ts";
import { writeCheckoutStorage } from "../../io/config.ts";
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
  /** `--personal` or `--repo`; absent leaves the checkout's choice as it was. */
  storage?: CommandOptions["storage"];
  /**
   * Absent in tests that are not about it: the real one downloads a model.
   * The composition root always passes it.
   */
  prefetchModel?: PrefetchModel;
}

export async function runInit({ config: resolved, repoRoot, stdio, storage, prefetchModel }: RunInitInput): Promise<ExitCode> {
  const say = (line: string): void => {
    stdio.output.write(`signposts: ${line}\n`);
  };

  let config = resolved;
  if (storage !== undefined) {
    writeCheckoutStorage(config.paths.checkoutConfigFile, storage);
    config = withStorage(config, storage);
  }
  const personal = config.storage === STORAGE_PERSONAL;

  const outcome = setUpRepo({ config, repoRoot, say });
  if (outcome.status === "no-origin") {
    stdio.error.write(
      "signposts: could not determine repo (owner/name) from the 'origin' git remote — is this a git repo with a GitHub origin configured? " +
        "`signpost init --personal` keeps signposts on this machine and needs no origin.\n",
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
  say(
    "ready. When you clear or close a Claude conversation here, Claude offers to write up what you worked out in it and " +
      (personal ? `keep it on this machine, in ${config.paths.knowledgeDir}.` : "open a pull request."),
  );
  await prefetchModel?.(config, say);
  return 0;
}
