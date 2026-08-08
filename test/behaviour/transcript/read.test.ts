// Behaviour test for the streaming reader — outside test/unit because the
// repo's mutation-graded unit suite (test/unit, driven by
// vitest.unit.config.ts / stryker.config.mjs) excludes src/io/. Root
// vitest.config.ts includes test/**/*.test.ts, so this still runs under
// `pnpm test`.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

import * as fs from "node:fs";
import { readTranscript } from "../../../src/io/transcript/read.js";
import { isHumanTurn } from "../../../src/core/transcript/classify.js";
import type { UserLine } from "../../../src/core/contracts/schema.js";

const line = (fields: Record<string, unknown>) =>
  JSON.stringify({
    uuid: "u",
    parentUuid: null,
    sessionId: "s",
    timestamp: "2026-01-01T00:00:00Z",
    type: "system",
    ...fields,
  });

describe("readTranscript", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "signposts-transcript-read-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function collect(filePath: string) {
    const { lines, counts } = readTranscript(filePath);
    const collected = [];
    for await (const l of lines) {
      collected.push(l);
    }
    return { collected, counts };
  }

  it("counts a truncated final line as malformed and skipped, completing normally with earlier lines yielded", async () => {
    const good1 = line({ uuid: "a" });
    const good2 = line({ uuid: "b" });
    const truncated = line({ uuid: "c" }).slice(0, -5);
    const file = path.join(dir, "truncated.jsonl");
    writeFileSync(file, [good1, good2, truncated].join("\n"));

    const { collected, counts } = await collect(file);

    expect(collected).toHaveLength(2);
    expect(collected.map((l) => l.uuid)).toEqual(["a", "b"]);
    expect(counts.linesSkipped).toBe(1);
    expect(counts.linesIgnored).toBe(0);
    expect(counts.linesRead).toBe(3);
    expect(counts.linesRead).toBe(collected.length + counts.linesSkipped);
  });

  it("counts unrecognised-type sidecar lines as ignored (not skipped), and still yields them", async () => {
    const good1 = line({ uuid: "a" });
    const good2 = line({ uuid: "b" });
    const mode = '{"type":"mode","mode":"normal","sessionId":"s1"}';
    const aiTitle = '{"type":"ai-title","aiTitle":"Some title","sessionId":"s1"}';
    const file = path.join(dir, "sidecar.jsonl");
    writeFileSync(file, [good1, mode, good2, aiTitle].join("\n"));

    const { collected, counts } = await collect(file);

    expect(collected).toHaveLength(4);
    expect(counts.linesRead).toBe(4);
    expect(counts.linesSkipped).toBe(0);
    expect(counts.linesIgnored).toBe(2);
    expect(counts.linesRead).toBe(collected.length + counts.linesSkipped);
  });

  it("skips garbage non-JSON lines interleaved with good ones, yielding good lines in order", async () => {
    const file = path.join(dir, "garbage.jsonl");
    writeFileSync(
      file,
      [line({ uuid: "a" }), "not json at all", line({ uuid: "b" }), "{also bad", line({ uuid: "c" })].join("\n"),
    );

    const { collected, counts } = await collect(file);

    expect(collected.map((l) => l.uuid)).toEqual(["a", "b", "c"]);
    expect(counts.linesSkipped).toBe(2);
    expect(counts.linesIgnored).toBe(0);
    expect(counts.linesRead).toBe(5);
  });

  it("records versions from a fixture with several version-2 lines", async () => {
    const file = path.join(dir, "known-major.jsonl");
    writeFileSync(
      file,
      [line({ uuid: "a", version: "2.1.223" }), line({ uuid: "b", version: "2.0.0" })].join("\n"),
    );

    const { counts } = await collect(file);

    expect([...counts.versionsSeen].sort()).toEqual(["2.0.0", "2.1.223"]);
  });

  it("records the version from an unrecognised-type (ignored) line, with no known-type line in the file at all", async () => {
    // Real shape: "attachment" sidecar lines carry a version field. Version
    // tracking is unqualified by line type — this must still record even
    // though every line in the file is "ignored", never "parsed".
    const file = path.join(dir, "attachment-only.jsonl");
    writeFileSync(
      file,
      [
        '{"type":"attachment","version":"3.0.1","sessionId":"s1"}',
        '{"type":"attachment","version":"3.0.1","sessionId":"s1"}',
      ].join("\n"),
    );

    const { collected, counts } = await collect(file);

    expect(collected).toHaveLength(2);
    expect(counts.linesIgnored).toBe(2);
    expect(counts.linesSkipped).toBe(0);
    expect([...counts.versionsSeen]).toEqual(["3.0.1"]);
  });

  it("closes the underlying file stream when the consumer breaks out of the generator early", async () => {
    const good = [line({ uuid: "a" }), line({ uuid: "b" }), line({ uuid: "c" }), line({ uuid: "d" }), line({ uuid: "e" })];
    const file = path.join(dir, "break-early.jsonl");
    writeFileSync(file, good.join("\n"));

    const createReadStreamMock = vi.mocked(fs.createReadStream);
    createReadStreamMock.mockClear();
    const { lines } = readTranscript(file);

    let seen = 0;
    for await (const l of lines) {
      void l;
      seen += 1;
      if (seen === 2) break;
    }

    const stream = createReadStreamMock.mock.results[0]?.value as fs.ReadStream;
    expect(stream.destroyed).toBe(true);
  });

  it("end-to-end: streams a real mixed transcript, filters to the one genuine human turn", async () => {
    // Real transcript samples, verbatim (see 02-ingestion.md and
    // test/unit/transcript/classify.test.ts's fixtures of the same shapes).
    const GENUINE_HUMAN_TURN: UserLine = {
      parentUuid: "52b3dc93-...",
      isSidechain: false,
      sessionId: "538d7b04-...",
      uuid: "88f130c9-...",
      timestamp: "2026-08-06T09:32:56.680Z",
      type: "user",
      message: { role: "user", content: "go on" },
      origin: { kind: "human" },
      cwd: "/Users/greg/Projects/signposts",
      version: "2.1.223",
      gitBranch: "main",
    };

    const SLASH_COMMAND_STDOUT: UserLine = {
      parentUuid: "0d75d20f-0806-4ddd-8141-8cda54ae91bd",
      isSidechain: false,
      sessionId: "554309cd-84e8-4b4c-b572-1b085f037ff8",
      uuid: "8ee0474f-30c6-472b-8722-5062591b9ac3",
      timestamp: "2026-08-02T13:12:59.967Z",
      type: "user",
      message: {
        role: "user",
        content:
          "<local-command-stdout>Set model to [1mSonnet 5[22m and saved as your default for new sessions</local-command-stdout>",
      },
      cwd: "/Users/greg/Projects/signposts",
      version: "2.1.220",
      gitBranch: "HEAD",
    };

    const SKILL_BODY_EXPANSION: UserLine = {
      parentUuid: "9f0506fc-...",
      isSidechain: false,
      sessionId: "s1",
      uuid: "skill-1",
      timestamp: "2026-08-06T08:20:00.000Z",
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "Base directory for this skill: /Users/greg/.claude/skills/dev-team\n\n# Dev Team\n...",
          },
        ],
      },
      version: "2.1.223",
    };

    const TOOL_RESULT: UserLine = {
      parentUuid: "8ee0474f-30c6-472b-8722-5062591b9ac3",
      isSidechain: false,
      sessionId: "554309cd-84e8-4b4c-b572-1b085f037ff8",
      uuid: "tool-result-1",
      timestamp: "2026-08-02T13:13:00.000Z",
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_01abc", content: "file written" }],
      },
      cwd: "/Users/greg/Projects/signposts",
      version: "2.1.220",
      gitBranch: "HEAD",
    };

    const SIDECAR_MODE = '{"type":"mode","mode":"normal","sessionId":"1e55648c-e427-4226-b7ea-38d38ec829f3"}';

    const file = path.join(dir, "mixed.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify(SLASH_COMMAND_STDOUT),
        JSON.stringify(SKILL_BODY_EXPANSION),
        JSON.stringify(TOOL_RESULT),
        SIDECAR_MODE,
        JSON.stringify(GENUINE_HUMAN_TURN),
      ].join("\n"),
    );

    const { collected, counts } = await collect(file);

    expect(collected).toHaveLength(5);
    expect(counts.linesSkipped).toBe(0);
    expect(counts.linesIgnored).toBe(1); // the sidecar mode line

    const humanTurns = collected.filter(isHumanTurn);

    expect(humanTurns).toHaveLength(1);
    expect(humanTurns[0]!.uuid).toBe("88f130c9-...");
    expect(humanTurns[0]!.origin).toEqual({ kind: "human" });
    expect(humanTurns[0]!.message).toEqual({ role: "user", content: "go on" });
  });

  it("fuzz: arbitrary strings joined as lines never throw, and skipped+parsed counts sum to lines read", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.string(), { maxLength: 20 }), async (rawLines) => {
        const file = path.join(dir, `fuzz-${Math.random()}.jsonl`);
        writeFileSync(file, rawLines.join("\n"));

        const { collected, counts } = await collect(file);

        expect(counts.linesSkipped + collected.length).toBe(counts.linesRead);
        // Some fc.string() samples ARE valid JSON (e.g. "1", "43") — but only
        // scalars, since fc.string() draws plain text, never object syntax
        // with a "type" key. A scalar fails otherLineSchema's looseObject
        // (which requires an object), so it lands in linesSkipped either way.
        // Sharpens the malformed/ignored boundary: "invalid JSON" and "valid
        // JSON, wrong shape" both land in linesSkipped, and only a real
        // object with an unrecognised `type` string reaches linesIgnored —
        // which is exactly what would catch a moved boundary.
        expect(counts.linesIgnored).toBe(0);
      }),
    );
  });
});
