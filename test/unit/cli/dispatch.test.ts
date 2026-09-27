import { describe, expect, it } from "vitest";
import { parseCommand, setsUpRepo } from "../../../src/core/cli/dispatch.js";

const NO_OPTIONS = { isFirst: false, adoptLock: false, verbose: false };

describe("parseCommand", () => {
  it.each([
    [["init"], { name: "init", options: NO_OPTIONS }],
    [["index"], { name: "index", options: NO_OPTIONS }],
    [["doctor"], { name: "doctor", options: NO_OPTIONS }],
    [["sessions"], { name: "sessions", options: NO_OPTIONS }],
    [["run"], { name: "run", options: NO_OPTIONS }],
    [["resume"], { name: "resume", options: NO_OPTIONS }],
    [["init", "--extra"], { name: "init", options: NO_OPTIONS }],
    [["mcp"], { name: "mcp", options: NO_OPTIONS }],
    [["bogus"], { name: "unknown" }],
    [[], { name: "unknown" }],
  ] as const)("parseCommand(%j) -> %j", (argv, expected) => {
    expect(parseCommand(argv)).toEqual(expected);
  });
});

describe("the run commands' options", () => {
  it("reads --session, --replies and --first", () => {
    const parsed = parseCommand(["resume", "--session", "s-1", "--replies", "-", "--first"]);

    expect(parsed).toEqual({
      name: "resume",
      options: { sessionId: "s-1", repliesPath: "-", isFirst: true, adoptLock: false, verbose: false },
    });
  });

  it("ignores a flag with no value rather than reading the next flag as one", () => {
    const parsed = parseCommand(["run", "--session"]);

    expect(parsed).toEqual({ name: "run", options: NO_OPTIONS });
  });

  it("does not swallow the next flag as a value", () => {
    // A machine-assembled command line is where a missing value shows up, and
    // `readFileSync("--session")` reports ENOENT rather than the missing
    // --replies it actually was.
    const parsed = parseCommand(["resume", "--replies", "--session", "abc"]);

    expect(parsed).toEqual({
      name: "resume",
      options: { sessionId: "abc", isFirst: false, adoptLock: false, verbose: false },
    });
  });

  it("reads --content-hash, the other half of a thread id", () => {
    const parsed = parseCommand(["resume", "--session", "s-1", "--content-hash", "deadbeef"]);

    expect(parsed).toEqual({
      name: "resume",
      options: { sessionId: "s-1", contentHash: "deadbeef", isFirst: false, adoptLock: false, verbose: false },
    });
  });

  it("ignores an argument that is not one of the flags", () => {
    expect(parseCommand(["run", "stray", "value"])).toEqual({ name: "run", options: NO_OPTIONS });
  });

  it("ignores --content-hash with no value", () => {
    expect(parseCommand(["resume", "--content-hash", "--first"])).toEqual({
      name: "resume",
      options: { isFirst: true, adoptLock: false, verbose: false },
    });
  });

  it("takes the value after the flag, wherever the flag sits", () => {
    const parsed = parseCommand(["run", "--first", "--session", "s-2"]);

    expect(parsed).toEqual({
      name: "run",
      options: { sessionId: "s-2", isFirst: true, adoptLock: false, verbose: false },
    });
  });
});

describe("worker", () => {
  // Dispatched but never typed by a person: the SessionStart hook spawns it.
  it("is a known command", () => {
    expect(parseCommand(["worker"])).toEqual({ name: "worker", options: NO_OPTIONS });
  });

  // The hook takes the run lock before spawning, and says so with this flag
  // rather than leaving the worker to guess from a pid.
  it("reads --adopt-lock", () => {
    expect(parseCommand(["worker", "--adopt-lock"])).toEqual({
      name: "worker",
      options: { isFirst: false, adoptLock: true, verbose: false },
    });
  });
});

describe("--verbose", () => {
  it("is off unless asked for", () => {
    expect(parseCommand(["run"])).toEqual({ name: "run", options: NO_OPTIONS });
  });

  it("is read wherever it sits, alongside the other flags", () => {
    expect(parseCommand(["resume", "--verbose", "--session", "s-1"])).toEqual({
      name: "resume",
      options: { sessionId: "s-1", isFirst: false, adoptLock: false, verbose: true },
    });
  });
});

describe("setsUpRepo", () => {
  // Replaces `spendsTokens`, which gated the same commands on a consent
  // typed at `init`. The skill's commands set the repo up themselves now
  // (src/cli/setup.ts); the free read path still writes nothing on a reader's
  // behalf (19-value-to-a-user.md, "Fewer human steps").
  it.each(["sessions", "run", "resume"] as const)("%s sets the repo up", (command) => {
    expect(setsUpRepo(command)).toBe(true);
  });

  it.each(["index", "worker", "init", "doctor", "mcp", "publish"] as const)("%s does not", (command) => {
    expect(setsUpRepo(command)).toBe(false);
  });
});

// 19-value-to-a-user.md item 5: both printed the one-line usage and exited 1.
describe("help and version", () => {
  it.each([["--help"], ["-h"], ["help"]])("%s asks for help", (flag) => {
    expect(parseCommand([flag])).toEqual({ name: "help" });
  });

  it.each([["--version"], ["-v"]])("%s asks for the version", (flag) => {
    expect(parseCommand([flag])).toEqual({ name: "version" });
  });

  it("a command's own --help asks for help rather than running it", () => {
    // `signpost run --help` spending tokens on the oldest session is the worst
    // possible reading of that command line.
    expect(parseCommand(["run", "--help"])).toEqual({ name: "help" });
  });
});
