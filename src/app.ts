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
import type { ExitCode } from "./core/cli/exit-codes.ts";
import { parseCommand, spendsTokens } from "./core/cli/dispatch.ts";
import { EXIT_CODES } from "./core/cli/exit-codes.ts";
import { hasConsent } from "./cli/consent.ts";
import { runInit, type PrefetchModel } from "./cli/commands/init.ts";
import { runIndex } from "./cli/commands/index.ts";
import { runDoctor } from "./cli/commands/doctor.ts";
import { runExtraction, runResume, runSessionsList } from "./cli/commands/run.ts";
import { runReview } from "./cli/commands/review.ts";
import { runWorker } from "./cli/commands/worker.ts";
import { runMcp } from "./cli/commands/mcp.ts";
import type { OpenRun } from "./cli/run-port.ts";

export type { ExitCode };

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
  /**
   * Fetches the embedding model at `init`. Optional so a test of anything else
   * does not download a model; production passes src/io/embed/prefetch.ts.
   */
  prefetchModel?: PrefetchModel;
  /**
   * What `--version` prints. Read from package.json by the composition root,
   * which is the one place that knows where the package is.
   */
  version?: string;
}

export interface App {
  run(argv: string[]): Promise<ExitCode>;
}

// `worker` and `mcp` are left out deliberately: the hook spawns one and the
// plugin manifest starts the other, nobody types either, and listing `worker`
// would invite someone to run the background process by hand expecting it to
// distil their sessions, which it cannot do (see cli/commands/worker.ts).
// `mcp` typed at a terminal is a server talking JSON-RPC to a keyboard.
const USAGE = "usage: signpost <init|index|doctor|sessions|run|resume|review> [--verbose]\n";

// What `--help` prints. The one-line USAGE above named no flag at all, so the
// only way to learn `--content-hash` was to read the skill or the source
// (19-value-to-a-user.md item 5).
const HELP = `${USAGE}
  init       consent, create .signposts/, and install the skill and status line
  index      rebuild the search index from the signposts on disk
  doctor     check this machine and repo; exits 1 if something blocks a run
  sessions   list transcripts eligible for a run (JSON)
  run        start a session and stop at its first halt (JSON)
               --session <id>        which session (default: the oldest eligible)
               --first               first session of a run: clears what the last run left pending
  resume     answer a halt and continue to the next (JSON)
               --session <id>        the session the halt reported
               --content-hash <hash> the contentHash the halt reported
               --replies <path|->    answers keyed by pending id; - reads stdin
  review     answer pending reviews yourself, at a terminal

  --verbose  narrate sessions, run and resume on stderr; stdout stays one JSON object
  --help     this text
  --version  the installed version
`;

function defaultStdio(): Stdio {
  return {
    input: process.stdin,
    output: process.stdout,
    error: process.stderr,
    interactive: process.stdin.isTTY === true,
  };
}

export function createApp({ config, openRun, stdio, version, prefetchModel }: CreateAppInput): App {
  const io = stdio ?? defaultStdio();
  const repoRoot = config.paths.repoRoot;

  return {
    async run(argv: string[]): Promise<ExitCode> {
      const command = parseCommand(argv);
      if (command.name === "unknown") {
        io.error.write(USAGE);
        return 1;
      }
      if (command.name === "help") {
        io.output.write(HELP);
        return EXIT_CODES.ok;
      }
      if (command.name === "version") {
        io.output.write(`${version ?? "unknown"}\n`);
        return EXIT_CODES.ok;
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
        verbose: command.options.verbose,
      };

      // Consent gates every command that can spend tokens, whichever path it
      // was typed on (./cli/consent.ts). `init` is exempt: it is the command
      // that asks.
      if (spendsTokens(command.name) && !hasConsent({ config, repoRoot, stderr: io.error })) {
        return EXIT_CODES.failure;
      }

      switch (command.name) {
        case "init":
          return runInit({
            config,
            repoRoot,
            stdio: io,
            ...(prefetchModel === undefined ? {} : { prefetchModel }),
          });
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
        case "worker":
          return runWorker({
            config,
            repoRoot,
            openRun,
            stderr: io.error,
            now: () => new Date(),
            adoptLock: command.options.adoptLock,
          });
        case "mcp":
          return runMcp({ config, repoRoot, stderr: io.error, stdin: io.input });
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
