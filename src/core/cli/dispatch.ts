// argv -> command decision, per 16-build-plan.md's core/io split: which
// subcommand runs, and with which options, is a pure function of argv.
// An unrecognised or missing subcommand is "unknown" and the caller prints
// usage + exits 1 — this module makes no decision about exit codes or
// output, only about what was asked for.
//
// The three run commands take options rather than positional arguments: they
// are driven by a skill, and a named flag survives being reordered by
// whatever assembles the command line.
//
// `review` takes none: it is typed by a person, and everything it acts on it
// finds for itself in the checkpoint database.

// `worker` and `mcp` are dispatched but not typed by a person: the SessionStart
// hook spawns the first (hooks/session-start.ts) and the plugin manifest
// starts the second (.claude-plugin/plugin.json). Both are commands rather
// than second binaries so that they go through the one composition root like
// everything else (R2) — a `bin/signpost-worker.js` building its own ports
// would be a second place that constructs them.
const KNOWN_COMMANDS = [
  "init",
  "index",
  "doctor",
  "sessions",
  "run",
  "resume",
  "review",
  "publish",
  "worker",
  "mcp",
] as const;
export type KnownCommand = (typeof KNOWN_COMMANDS)[number];

/**
 * The commands that can reach a model call, and therefore may not run before
 * this repo has consented (15-spec.md story 70, src/cli/consent.ts).
 *
 * `sessions`, `index`, `worker` and `mcp` are not among them on purpose:
 * listing transcripts, building the index, taking the census and searching it
 * are local and free, and 05-retrieval.md is explicit that a reader who never
 * runs an extraction is never asked for anything.
 */
export function spendsTokens(command: KnownCommand): boolean {
  return command === "run" || command === "resume" || command === "review";
}

/** Options the run commands accept; absent for the others. */
export interface CommandOptions {
  /** `--session <id>` — which session to run or resume. */
  sessionId?: string;
  /** `--content-hash <hash>` — the other half of the thread id, for a resume. */
  contentHash?: string;
  /** `--replies <path>` — the answers to a halt, or `-` for stdin. */
  repliesPath?: string;
  /** `--first` — this is the first session of a fresh run. */
  isFirst: boolean;
  /** `--adopt-lock` — the hook already took the run lock and is handing it over. */
  adoptLock: boolean;
  /**
   * `--verbose` — narrate the run on stderr as it happens.
   *
   * For the developer driving the loop by hand (15-spec.md story 71): stdout
   * is one JSON object and says nothing about which session was picked, what
   * the halt is waiting on, or what to type next. stderr is where that goes,
   * so the JSON contract on stdout is untouched and a pipe through `jq` still
   * works.
   */
  verbose: boolean;
}

export type ParsedCommand =
  | { name: KnownCommand; options: CommandOptions }
  | { name: "help" }
  | { name: "version" }
  | { name: "unknown" };

const HELP_ARGS: readonly string[] = ["--help", "-h", "help"];
const VERSION_ARGS: readonly string[] = ["--version", "-v"];

const SESSION_FLAG = "--session";
const CONTENT_HASH_FLAG = "--content-hash";
const REPLIES_FLAG = "--replies";
const FIRST_FLAG = "--first";
const ADOPT_LOCK_FLAG = "--adopt-lock";
const VERBOSE_FLAG = "--verbose";

/**
 * A flag's value, or undefined when the next argument is another flag.
 *
 * `--replies --session abc` used to read "--session" as the path, which
 * surfaced as ENOENT on a file called `--session` rather than as the missing
 * value it was. A machine-assembled command line is exactly where a value
 * goes missing, which is the case these named flags exist for.
 */
function valueAt(argv: readonly string[], index: number): string | undefined {
  const value = argv[index];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function parseOptions(argv: readonly string[]): CommandOptions {
  const options: CommandOptions = { isFirst: false, adoptLock: false, verbose: false };
  for (const [index, argument] of argv.entries()) {
    if (argument === FIRST_FLAG) {
      options.isFirst = true;
    } else if (argument === ADOPT_LOCK_FLAG) {
      options.adoptLock = true;
    } else if (argument === VERBOSE_FLAG) {
      options.verbose = true;
    } else if (argument === SESSION_FLAG) {
      const value = valueAt(argv, index + 1);
      if (value !== undefined) {
        options.sessionId = value;
      }
    } else if (argument === CONTENT_HASH_FLAG) {
      const value = valueAt(argv, index + 1);
      if (value !== undefined) {
        options.contentHash = value;
      }
    } else if (argument === REPLIES_FLAG) {
      const value = valueAt(argv, index + 1);
      if (value !== undefined) {
        options.repliesPath = value;
      }
    }
  }
  return options;
}

function isKnownCommand(value: string | undefined): value is KnownCommand {
  return value !== undefined && (KNOWN_COMMANDS as readonly string[]).includes(value);
}

/** `argv` is the user-supplied argument list (not `process.argv` — no `node`/script path prefix). */
export function parseCommand(argv: readonly string[]): ParsedCommand {
  // Anywhere on the line, not only first: `signpost run --help` must not run.
  if (argv.some((arg) => HELP_ARGS.includes(arg))) {
    return { name: "help" };
  }
  if (VERSION_ARGS.some((arg) => arg === argv[0])) {
    return { name: "version" };
  }
  const [first, ...rest] = argv;
  if (isKnownCommand(first)) {
    return { name: first, options: parseOptions(rest) };
  }
  return { name: "unknown" };
}
