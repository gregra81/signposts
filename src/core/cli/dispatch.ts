// argv -> command decision, per 16-build-plan.md's core/io split: which
// subcommand runs, and with which options, is a pure function of argv.
// An unrecognised or missing subcommand is "unknown" and the caller prints
// usage + exits 1 — this module makes no decision about exit codes or
// output, only about what was asked for.
//
// The three run commands take options rather than positional arguments: they
// are driven by a skill, and a named flag survives being reordered by
// whatever assembles the command line.

const KNOWN_COMMANDS = ["init", "index", "doctor", "sessions", "run", "resume"] as const;
export type KnownCommand = (typeof KNOWN_COMMANDS)[number];

/** Options the run commands accept; absent for the others. */
export interface CommandOptions {
  /** `--session <id>` — which session to run or resume. */
  sessionId?: string;
  /** `--replies <path>` — the answers to a halt, or `-` for stdin. */
  repliesPath?: string;
  /** `--first` — this is the first session of a fresh run. */
  isFirst: boolean;
}

export type ParsedCommand = { name: KnownCommand; options: CommandOptions } | { name: "unknown" };

const SESSION_FLAG = "--session";
const REPLIES_FLAG = "--replies";
const FIRST_FLAG = "--first";

function parseOptions(argv: readonly string[]): CommandOptions {
  const options: CommandOptions = { isFirst: false };
  for (const [index, argument] of argv.entries()) {
    if (argument === FIRST_FLAG) {
      options.isFirst = true;
    } else if (argument === SESSION_FLAG) {
      const value = argv[index + 1];
      if (value !== undefined) {
        options.sessionId = value;
      }
    } else if (argument === REPLIES_FLAG) {
      const value = argv[index + 1];
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
  const [first, ...rest] = argv;
  if (isKnownCommand(first)) {
    return { name: first, options: parseOptions(rest) };
  }
  return { name: "unknown" };
}
