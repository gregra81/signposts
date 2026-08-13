// argv -> command decision, per 16-build-plan.md's core/io split: which
// subcommand runs is a pure function of argv[0], nothing else. Slice A only
// wires up init/index/doctor (R2/R6); an unrecognised or missing subcommand
// is "unknown" and the caller prints usage + exits 1 — this module makes no
// decision about exit codes or output, only about the command name.

const KNOWN_COMMANDS = ["init", "index", "doctor"] as const;
export type KnownCommand = (typeof KNOWN_COMMANDS)[number];

export type ParsedCommand = { name: KnownCommand } | { name: "unknown" };

function isKnownCommand(value: string | undefined): value is KnownCommand {
  return value !== undefined && (KNOWN_COMMANDS as readonly string[]).includes(value);
}

/** `argv` is the user-supplied argument list (not `process.argv` — no `node`/script path prefix). */
export function parseCommand(argv: readonly string[]): ParsedCommand {
  const [first] = argv;
  if (isKnownCommand(first)) {
    return { name: first };
  }
  return { name: "unknown" };
}
