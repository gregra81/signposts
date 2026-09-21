// The lines `--verbose` narrates (15-spec.md story 71).

import { describe, expect, it } from "vitest";
import {
  contextLines,
  eligibleLine,
  finishedLines,
  haltedLines,
  resumingLine,
  sessionLine,
  startingLine,
  type VerboseSession,
} from "../../../src/core/cli/verbose.js";

const SESSION: VerboseSession = {
  sessionId: "01J9FSESSION",
  contentHash: "deadbeef",
  transcriptPath: "/home/greg/.claude/projects/-repo/01J9FSESSION.jsonl",
  lastActivityAt: "2026-09-06T09:00:00.000Z",
};

describe("contextLines", () => {
  it("names the repo and the state directory a bug report would have to quote", () => {
    expect(contextLines({ repo: "acme/api", stateDir: "/home/greg/.signposts/ab12cd34" })).toEqual([
      "repo acme/api",
      "state /home/greg/.signposts/ab12cd34",
    ]);
  });
});

describe("eligibleLine and sessionLine", () => {
  it("counts what a run would take", () => {
    expect(eligibleLine(3)).toContain("3");
  });

  it("carries both halves of the thread id, since resume needs both", () => {
    const line = sessionLine(SESSION);
    expect(line).toContain(SESSION.sessionId);
    expect(line).toContain(SESSION.contentHash);
    expect(line).toContain(SESSION.transcriptPath);
    expect(line).toContain(SESSION.lastActivityAt);
  });
});

describe("startingLine and resumingLine", () => {
  it("says which transcript is being read", () => {
    expect(startingLine(SESSION)).toContain(SESSION.transcriptPath);
  });

  it("says how many answers arrived and where from", () => {
    const line = resumingLine(SESSION, "/tmp/replies.json", 3);
    expect(line).toContain("3");
    expect(line).toContain("/tmp/replies.json");
  });
});

describe("haltedLines", () => {
  it("lists every halt by its own interrupt id, because classify fans out", () => {
    const lines = haltedLines(SESSION, [
      { kind: "model_call", node: "classify", interruptId: "int-1" },
      { kind: "model_call", node: "classify", interruptId: "int-2" },
    ]);

    expect(lines[0]).toContain("2");
    expect(lines.join("\n")).toContain("int-1");
    expect(lines.join("\n")).toContain("int-2");
  });

  it("names the node a model call halted at", () => {
    const [, entry] = haltedLines(SESSION, [
      { kind: "model_call", node: "classify", interruptId: "int-1" },
    ]);
    expect(entry).toBe("  model_call at classify — answer under id int-1");
  });

  it("names no node for a review — it is the run's halt, not one node's", () => {
    const [, entry] = haltedLines(SESSION, [
      { kind: "human_review", node: undefined, interruptId: "int-9" },
    ]);
    expect(entry).toBe("  human_review — answer under id int-9");
  });

  it("ends with the resume command, both halves of the thread id filled in", () => {
    const last = haltedLines(SESSION, [{ kind: "model_call", node: "extract", interruptId: "i" }]).at(-1);
    expect(last).toContain(`--session ${SESSION.sessionId}`);
    expect(last).toContain(`--content-hash ${SESSION.contentHash}`);
    expect(last).toContain("--replies");
  });
});

describe("finishedLines", () => {
  it("lists what was proposed", () => {
    const lines = finishedLines(["add staging-read-only: staging is read only", "retire old-claim"], 2);
    expect(lines[0]).toContain("2 operation(s)");
    expect(lines.join("\n")).toContain("staging is read only");
  });

  // 19-value-to-a-user.md: a batch the critic sent back is re-extracted, and
  // nothing used to say so — the developer saw fewer proposals and no reason.
  it("says how many times the batch went back to extract", () => {
    const lines = finishedLines([], 0, 1).join("\n");
    expect(lines).toContain("critic sent the batch back");
    expect(lines).toContain("1");
  });

  it("stays silent about re-extraction when there was none", () => {
    expect(finishedLines([], 0, 0).join("\n")).not.toContain("critic sent the batch back");
  });

  it("says the run is done only when nothing else is eligible", () => {
    expect(finishedLines([], 0).at(-1)).toContain("done");
    expect(finishedLines([], 1).at(-1)).toContain("1 session(s) still eligible");
  });
});
