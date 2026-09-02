// gutterSession is the first module that assembles a whole GutteredSession
// and hands it to `extract`, so it is where 02-ingestion.md's "Nothing leaves
// the machine unredacted" stops being an intention and becomes reachable
// code. These cover the redaction pass over a real transcript on disk: the
// prose, the file paths beside it, and the fail-closed boundary.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gutterSession } from "../../../src/io/gutter/session.js";
import { AUTHOR_PSEUDONYM_PREFIX } from "../../../src/core/config/constants.js";

const REPO_ROOT = "/Users/dev/Projects/platform";
const SCOPE = { repo: "acme/platform", repoRoot: REPO_ROOT };

const envelope = (fields: Record<string, unknown>) => ({
  uuid: "u1",
  parentUuid: null,
  sessionId: "s1",
  timestamp: "2026-01-01T00:00:00Z",
  gitBranch: "main",
  ...fields,
});

// `origin.kind === "human"` is the load-bearing check in
// src/core/transcript/classify.ts — a user line without it is tool output
// wearing a user hat, and the gutter drops it.
const humanLine = (text: string) =>
  JSON.stringify(
    envelope({ type: "user", origin: { kind: "human" }, message: { role: "user", content: text } }),
  );

const assistantLine = (blocks: unknown[]) =>
  JSON.stringify(
    envelope({ uuid: "u2", type: "assistant", message: { role: "assistant", content: blocks } }),
  );

describe("gutterSession — redaction", () => {
  let dir: string;
  let transcript: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "signposts-session-"));
    transcript = path.join(dir, "session.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(lines: string[]): void {
    writeFileSync(transcript, `${lines.join("\n")}\n`, "utf8");
  }

  it("pseudonymises an email address in a human turn", async () => {
    write([humanLine("dana@acme.example says the migration is wrong")]);

    const session = await gutterSession(transcript, SCOPE);

    expect(session.turns[0]?.text).not.toContain("dana@acme.example");
    expect(session.turns[0]?.text).toContain(AUTHOR_PSEUDONYM_PREFIX);
  });

  it("redacts secrets in a human turn, as it always did", async () => {
    write([humanLine("the key is AKIAIOSFODNN7EXAMPLE")]);

    const session = await gutterSession(transcript, SCOPE);

    expect(session.turns[0]?.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("redacts filesTouched, not only the prose beside it", async () => {
    // Absolute paths are lifted verbatim out of `tool_use` inputs, so a home
    // directory named after a person leaves the machine with the turn.
    write([
      humanLine("fix the config"),
      assistantLine([
        { type: "text", text: "editing it now" },
        {
          type: "tool_use",
          id: "t1",
          name: "Edit",
          input: { file_path: "/Users/dana@acme.example/src/config.ts" },
        },
      ]),
    ]);

    const session = await gutterSession(transcript, SCOPE);
    const assistant = session.turns.find((turn) => turn.role === "assistant");

    expect(assistant?.filesTouched?.[0]).not.toContain("dana@acme.example");
    expect(assistant?.filesTouched?.[0]).toContain(AUTHOR_PSEUDONYM_PREFIX);
    expect(assistant?.filesTouched?.[0]).toContain("/src/config.ts");
  });

  it("counts a turn whose only change was a file path", async () => {
    write([
      humanLine("fix the config"),
      assistantLine([
        { type: "text", text: "editing it now" },
        {
          type: "tool_use",
          id: "t1",
          name: "Edit",
          input: { file_path: "/Users/dana@acme.example/src/config.ts" },
        },
      ]),
    ]);

    const session = await gutterSession(transcript, SCOPE);

    expect(session.redactionCount).toBe(1);
  });

  it("gives the same person the same pseudonym across two sessions of the same repo", async () => {
    write([humanLine("dana@acme.example filed it")]);
    const first = await gutterSession(transcript, SCOPE);

    const second = path.join(dir, "other.jsonl");
    writeFileSync(second, `${humanLine("and dana@acme.example closed it")}\n`, "utf8");
    const other = await gutterSession(second, SCOPE);

    const pseudonym = /author-[0-9a-f]{4}/;
    expect(first.turns[0]?.text.match(pseudonym)?.[0]).toBe(other.turns[0]?.text.match(pseudonym)?.[0]);
  });

  it("leaves a turn with nothing to redact untouched, and counts nothing", async () => {
    write([humanLine("the build fails on node 24")]);

    const session = await gutterSession(transcript, SCOPE);

    expect(session.turns[0]?.text).toBe("the build fails on node 24");
    expect(session.redactionCount).toBe(0);
  });
});
