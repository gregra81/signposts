// The pure half of the resolver's tools: caps, argv, parsing, slicing.
//
// These were reachable only through a real filesystem and a real `git` until
// the io half was split out. Now they are ordinary functions over strings,
// which is what lets the mutation gate grade the decisions inside them — a
// grep exit status read as a failure instead of "no matches", a limit that
// stops being clamped, a slice that goes 0-based.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_GIT_LOG_LIMIT,
  MAX_GIT_LOG_LIMIT,
  MAX_GREP_MATCHES,
  MAX_TOOL_RESULT_CHARS,
  failed,
  gitLogArgs,
  grepArgs,
  ok,
  parseGitLog,
  parseGrep,
  pathspecFor,
  sliceLines,
  withStderr,
} from "../../../src/core/tools/repo-tools.js";

/** The unit separator `git log --pretty` is asked to delimit fields with. */
const SEP = "\u001F";

const commitLine = (hash: string, author: string, date: string, subject: string): string =>
  [hash, author, date, subject].join(SEP);

describe("ok", () => {
  it("passes content through untouched when it fits", () => {
    expect(ok("two lines\nof it")).toEqual({ content: "two lines\nof it", isError: false });
  });

  it("truncates content that would flood the conversation, and says so", () => {
    const result = ok("x".repeat(MAX_TOOL_RESULT_CHARS + 1));

    expect(result.isError).toBe(false);
    expect(result.content).toContain("truncated");
    expect(result.content.startsWith("x".repeat(MAX_TOOL_RESULT_CHARS))).toBe(true);
  });

  it("leaves content exactly at the cap alone", () => {
    const result = ok("x".repeat(MAX_TOOL_RESULT_CHARS));

    expect(result.content).not.toContain("truncated");
    expect(result.content).toHaveLength(MAX_TOOL_RESULT_CHARS);
  });
});

describe("failed", () => {
  it("marks the result as an error the model should read", () => {
    expect(failed("rejected: nope")).toEqual({ content: "rejected: nope", isError: true });
  });
});

describe("withStderr", () => {
  it("appends git's complaint so a bad pattern can be corrected", () => {
    expect(withStderr("git grep exited 128", "fatal: repetition-operator operand invalid")).toBe(
      "git grep exited 128: fatal: repetition-operator operand invalid",
    );
  });

  it("leaves the message alone when git said nothing", () => {
    expect(withStderr("git grep exited 128", "")).toBe("git grep exited 128");
  });

  it("treats whitespace-only stderr as nothing said", () => {
    expect(withStderr("git log exited 1", "  \n ")).toBe("git log exited 1");
  });
});

describe("sliceLines", () => {
  const FILE = "one\ntwo\nthree\nfour";

  it("returns the whole file when neither bound is given", () => {
    expect(sliceLines(FILE, undefined, undefined)).toEqual({ content: FILE, isError: false });
  });

  it("numbers a slice 1-based and inclusive on both ends", () => {
    expect(sliceLines(FILE, 2, 3).content).toBe("2: two\n3: three");
  });

  it("reads to the end of the file when only startLine is given", () => {
    expect(sliceLines(FILE, 3, undefined).content).toBe("3: three\n4: four");
  });

  it("reads from the first line when only endLine is given", () => {
    expect(sliceLines(FILE, undefined, 2).content).toBe("1: one\n2: two");
  });

  it("clamps an endLine past the end rather than failing", () => {
    const result = sliceLines(FILE, 4, 999);

    expect(result.isError).toBe(false);
    expect(result.content).toBe("4: four");
  });

  it("returns a single line when both bounds name it", () => {
    expect(sliceLines(FILE, 1, 1).content).toBe("1: one");
  });

  it("rejects a range that runs backwards instead of quietly swapping it", () => {
    const result = sliceLines(FILE, 3, 2);

    expect(result.isError).toBe(true);
    expect(result.content).toBe("read_file: endLine 2 is before startLine 3");
  });
});

describe("pathspecFor", () => {
  it("makes the path relative to the root git runs in", () => {
    expect(pathspecFor("/repo", "/repo/src/config.ts")).toEqual(["--", "src/config.ts"]);
  });

  it("names the root itself as '.', never as an empty argument", () => {
    // An empty pathspec argument is not "everything" to git — it is an error.
    expect(pathspecFor("/repo", "/repo")).toEqual(["--", "."]);
  });
});

describe("gitLogArgs", () => {
  it("uses the default limit when the model named none", () => {
    expect(gitLogArgs(undefined, [])).toContain(`--max-count=${DEFAULT_GIT_LOG_LIMIT}`);
  });

  it("honours a limit the model named", () => {
    expect(gitLogArgs(3, [])).toContain("--max-count=3");
  });

  it("clamps a limit above the ceiling", () => {
    expect(gitLogArgs(MAX_GIT_LOG_LIMIT + 1000, [])).toContain(`--max-count=${MAX_GIT_LOG_LIMIT}`);
  });

  it("keeps a limit exactly at the ceiling", () => {
    expect(gitLogArgs(MAX_GIT_LOG_LIMIT, [])).toContain(`--max-count=${MAX_GIT_LOG_LIMIT}`);
  });

  it("puts the pathspec last, after the pretty format", () => {
    expect(gitLogArgs(5, ["--", "src"]).slice(-2)).toEqual(["--", "src"]);
  });

  it("asks for the four fields the parser reads back", () => {
    const format = gitLogArgs(1, []).find((arg) => arg.startsWith("--pretty="));

    expect(format).toBe(`--pretty=format:%H${SEP}%an${SEP}%aI${SEP}%s`);
  });
});

describe("grepArgs", () => {
  it("passes the pattern behind -e, so a pattern starting with a dash is not a flag", () => {
    const args = grepArgs("-v", []);

    expect(args[args.indexOf("-e") + 1]).toBe("-v");
  });

  it("caps the matches git will return", () => {
    expect(grepArgs("x", [])).toContain(`--max-count=${MAX_GREP_MATCHES}`);
  });

  it("skips binary files", () => {
    expect(grepArgs("x", [])).toContain("-I");
  });

  it("puts the pathspec last", () => {
    expect(grepArgs("x", ["--", "src"]).slice(-2)).toEqual(["--", "src"]);
  });
});

describe("parseGitLog", () => {
  it("turns each line into a commit", () => {
    const result = parseGitLog(
      0,
      [
        commitLine("abc123", "Dev", "2026-09-04T10:00:00+03:00", "Make staging read-only"),
        commitLine("def456", "Dev", "2026-01-01T10:00:00+02:00", "Allow writes to staging"),
      ].join("\n"),
      "",
    );

    expect(JSON.parse(result.content)).toEqual([
      { hash: "abc123", author: "Dev", date: "2026-09-04T10:00:00+03:00", subject: "Make staging read-only" },
      { hash: "def456", author: "Dev", date: "2026-01-01T10:00:00+02:00", subject: "Allow writes to staging" },
    ]);
  });

  it("returns an empty list for a path with no history", () => {
    const result = parseGitLog(0, "", "");

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual([]);
  });

  it("keeps a subject whole even if it somehow contains the separator", () => {
    const result = parseGitLog(0, `abc${SEP}Dev${SEP}2026-09-04${SEP}one${SEP}two`, "");

    expect(JSON.parse(result.content)[0].subject).toBe(`one${SEP}two`);
  });

  it("reports a non-zero exit as an error, with git's reason", () => {
    const result = parseGitLog(128, "", "fatal: not a git repository");

    expect(result.isError).toBe(true);
    expect(result.content).toBe("git_log: git log exited 128: fatal: not a git repository");
  });
});

describe("parseGrep", () => {
  it("returns the matching lines", () => {
    const result = parseGrep("staging", 0, "src/config.ts:1:const STAGING = false;", "");

    expect(result.isError).toBe(false);
    expect(result.content).toBe("src/config.ts:1:const STAGING = false;");
  });

  it("reports exit 1 as no matches, which is an answer and not a failure", () => {
    const result = parseGrep("nothing", 1, "", "");

    expect(result.isError).toBe(false);
    expect(result.content).toBe("no matches for nothing");
  });

  it("reports an empty exit-0 result as no matches too", () => {
    expect(parseGrep("nothing", 0, "", "").isError).toBe(false);
  });

  it("reports anything above 1 as git objecting, with its reason", () => {
    const result = parseGrep("(?i)x", 128, "", "fatal: repetition-operator operand invalid");

    expect(result.isError).toBe(true);
    expect(result.content).toBe(
      "grep_repo: git grep exited 128: fatal: repetition-operator operand invalid",
    );
  });

  it("caps the matches it hands back even if git returned more", () => {
    const flood = Array.from({ length: MAX_GREP_MATCHES + 50 }, (_, i) => `f.ts:${i}:x`).join("\n");

    expect(parseGrep("x", 0, flood, "").content.split("\n")).toHaveLength(MAX_GREP_MATCHES);
  });
});
