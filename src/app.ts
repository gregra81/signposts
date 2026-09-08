// Composition root (15-spec.md D1, 16-build-plan.md step 15): the single
// factory that assembles the application from a resolved config plus what it
// needs injected, and returns an object whose only public entry point is
// `run(argv)`. Nothing else in the codebase constructs a port (R2) —
// bin/signpost.js calls this with the production `openRun` and process.argv;
// tests call it at the same seam with a temp config.
//
// `openRun` rather than a bag of built ports: a run's resources — a database
// handle, a checkpointer, an embedder — live for one invocation, and opening
// them here would open a database for `doctor` and one for `init` before
// consent. See src/cli/run-port.ts.
//
// `repo` (the "owner/name" key used across repo_state/signposts) is NOT
// resolved here:
// only `init`/`index` need it, and deriving it requires a GitHub `origin`
// remote that may not exist — `doctor` must run without one (it's the
// command you run when setup is broken), so each of `init`/`index` resolves
// its own `repo` lazily, as a graceful error rather than a composition-root
// throw. `stdio` is a stream bundle, not a port: it stands in
// for the real terminal (consent prompt input/output, usage and report
// output) and defaults to the real process streams so bin/signpost.js
// doesn't have to wire it explicitly; tests substitute their own streams
// the same way they substitute ports.

import type { ResolvedConfig } from "./core/config/resolve.ts";
import { parseCommand } from "./core/cli/dispatch.ts";
import { runInit } from "./cli/commands/init.ts";
import { runIndex } from "./cli/commands/index.ts";
import { runDoctor } from "./cli/commands/doctor.ts";
import { runExtraction, runResume, runSessionsList } from "./cli/commands/run.ts";
import { runReview } from "./cli/commands/review.ts";
import type { OpenRun } from "./cli/run-port.ts";

export type ExitCode = 0 | 1;

export interface Stdio {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  error: NodeJS.WritableStream;
  /**
   * Whether a person is at the other end of `input`. Read from the real
   * process here and nowhere below (R7), because `review` refuses to run
   * without one — a review answered by a pipe was answered by nobody.
   * Defaults to false: a caller that assembles its own streams is not a
   * terminal unless it says so.
   */
  interactive?: boolean;
}

export interface CreateAppInput {
  config: ResolvedConfig;
  /** Opens what a run command needs, for one invocation — see src/cli/run-port.ts. */
  openRun: OpenRun;
  /** Defaults to the real process streams — see module comment. */
  stdio?: Stdio;
}

export interface App {
  run(argv: string[]): Promise<ExitCode>;
}

const USAGE = "usage: signpost <init|index|doctor|sessions|run|resume|review>\n";

function defaultStdio(): Stdio {
  return {
    input: process.stdin,
    output: process.stdout,
    error: process.stderr,
    interactive: process.stdin.isTTY === true,
  };
}

export function createApp({ config, openRun, stdio }: CreateAppInput): App {
  const io = stdio ?? defaultStdio();
  const repoRoot = config.paths.repoRoot;

  return {
    async run(argv: string[]): Promise<ExitCode> {
      const command = parseCommand(argv);
      if (command.name === "unknown") {
        io.error.write(USAGE);
        return 1;
      }

      // The three run commands share their input; only which one is called
      // differs, so it is assembled once.
      const runInput = {
        config,
        repoRoot,
        openRun,
        stdout: io.output,
        stderr: io.error,
        ...(command.options.sessionId === undefined ? {} : { sessionId: command.options.sessionId }),
        ...(command.options.contentHash === undefined ? {} : { contentHash: command.options.contentHash }),
        ...(command.options.repliesPath === undefined ? {} : { repliesPath: command.options.repliesPath }),
        isFirst: command.options.isFirst,
      };

      switch (command.name) {
        case "init":
          return runInit({ config, repoRoot, stdio: io });
        case "index":
          return runIndex({ config, repoRoot, stderr: io.error });
        case "doctor":
          return runDoctor({ config, repoRoot, stdout: io.output });
        case "sessions":
          return runSessionsList(runInput);
        case "run":
          return runExtraction(runInput);
        case "resume":
          return runResume(runInput);
        case "review":
          return runReview({
            config,
            repoRoot,
            openRun,
            stdio: io,
            interactive: io.interactive === true,
          });
      }
    },
  };
}
