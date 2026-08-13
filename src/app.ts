// Composition root (15-spec.md D1, 16-build-plan.md step 15): the single
// factory that assembles the application from a resolved config plus the
// three injected ports and returns an object whose only public entry point
// is `run(argv)`. Nothing else in the codebase constructs a port (R2) —
// bin/signpost.js calls this with production ports and process.argv;
// tests call it with fakes and a temp config.
//
// `credentials` (env-var presence for `doctor`) is resolved once, at the
// composition root (src/io/production-app.ts), and passed down as a plain
// value — nothing below this module reads `process.env` (R7). `repo` (the
// "owner/name" key used across repo_state/signposts) is NOT resolved here:
// only `init`/`index` need it, and deriving it requires a GitHub `origin`
// remote that may not exist — `doctor` must run without one (it's the
// command you run when setup is broken), so each of `init`/`index` resolves
// its own `repo` lazily, as a graceful error rather than a composition-root
// throw. `stdio` is a stream bundle, not a port: it stands in
// for the real terminal (consent prompt input/output, usage and report
// output) and defaults to the real process streams so bin/signpost.js
// doesn't have to wire it explicitly; tests substitute their own streams
// the same way they substitute ports.

import type { ModelProvider } from "./core/model/types.ts";
import type { ResolvedConfig } from "./core/config/resolve.ts";
import { parseCommand } from "./core/cli/dispatch.ts";
import { runInit } from "./cli/commands/init.ts";
import { runIndex } from "./cli/commands/index.ts";
import { runDoctor } from "./cli/commands/doctor.ts";

export type ExitCode = 0 | 1;

export interface Clock {
  now(): Date;
}

/** Hosted-PR surface only (15-spec.md D1) — git itself (branch/commit/push) is real git, not behind this port. */
export interface Forge {
  /** The open PR number for `branch`, or null if none exists. */
  hasOpenPr(branch: string): Promise<number | null>;
  openPr(input: { branch: string; title: string; body: string }): Promise<number>;
  updatePr(prNumber: number, body: string): Promise<void>;
  setLabels(prNumber: number, labels: readonly string[]): Promise<void>;
}

export interface Ports {
  model: ModelProvider;
  clock: Clock;
  forge: Forge;
}

export interface Stdio {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  error: NodeJS.WritableStream;
}

export interface CreateAppInput {
  config: ResolvedConfig;
  ports: Ports;
  /** Env-var presence only, never the credential value — see module comment. */
  credentials: { hasApiKey: boolean; hasAuthToken: boolean };
  /** Defaults to the real process streams — see module comment. */
  stdio?: Stdio;
}

export interface App {
  run(argv: string[]): Promise<ExitCode>;
}

const USAGE = "usage: signpost <init|index|doctor>\n";

function defaultStdio(): Stdio {
  return { input: process.stdin, output: process.stdout, error: process.stderr };
}

export function createApp({ config, ports, credentials, stdio }: CreateAppInput): App {
  const io = stdio ?? defaultStdio();
  const repoRoot = config.paths.repoRoot;

  return {
    async run(argv: string[]): Promise<ExitCode> {
      const command = parseCommand(argv);

      switch (command.name) {
        case "init":
          return runInit({ config, repoRoot, stdio: io });
        case "index":
          return runIndex({ config, repoRoot, stderr: io.error });
        case "doctor":
          return runDoctor({ config, repoRoot, credentials, stdout: io.output });
        case "unknown":
          io.error.write(USAGE);
          return 1;
      }
    },
  };
}
