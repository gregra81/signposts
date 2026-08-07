import { describe, expect, it } from "vitest";
import { isHumanTurn, isUserLine, parseLine } from "../../../src/core/transcript/classify.js";
import type { TranscriptLine, UserLine } from "../../../src/core/contracts/schema.js";

const baseEnvelope = {
  uuid: "u1",
  parentUuid: null,
  sessionId: "s1",
  timestamp: "2026-01-01T00:00:00Z",
};

// Real transcript samples, verbatim (see 02-ingestion.md and this build
// step's task description).
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
      "<local-command-stdout>Set model to [1mSonnet 5[22m and saved as your default for new sessions</local-command-stdout>",
  },
  cwd: "/Users/greg/Projects/signposts",
  version: "2.1.220",
  gitBranch: "HEAD",
};

const SLASH_COMMAND_INVOCATION: UserLine = {
  parentUuid: null,
  isSidechain: false,
  sessionId: "538d7b04-...",
  uuid: "9f0506fc-...",
  timestamp: "2026-08-06T08:17:46.619Z",
  type: "user",
  message: {
    role: "user",
    content: "<command-message>dev-team</command-message>\n<command-name>/dev-team</command-name>\n<command-args>...</command-args>",
  },
  cwd: "/Users/greg/Projects/signposts",
  version: "2.1.223",
  gitBranch: "main",
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

// Table-driven cases for isHumanTurn (R5). Each row is independently
// distinct — no case is a strict subset of another's setup.
const cases: Array<[string, UserLine, boolean]> = [
  ["slash-command stdout wearing a user hat (no origin)", SLASH_COMMAND_STDOUT, false],
  ["slash-command invocation tags (no origin)", SLASH_COMMAND_INVOCATION, false],
  ["skill-body expansion: content array of text blocks, no origin", SKILL_BODY_EXPANSION, false],
  ["genuine typed human turn", GENUINE_HUMAN_TURN, true],
  [
    "all-tool_result content array WITH origin.kind === human — still false: the all-tool_result rule is independent",
    {
      ...baseEnvelope,
      type: "user",
      message: { role: "user", content: [{ type: "tool_result" }] },
      origin: { kind: "human" },
    },
    false,
  ],
  [
    "content array mixing one tool_result and one text block, origin human — true (every, not some)",
    {
      ...baseEnvelope,
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result" }, { type: "text", text: "hi" }],
      },
      origin: { kind: "human" },
    },
    true,
  ],
  [
    "bare toolUseResult field present, origin human, plain-string content — false",
    {
      ...baseEnvelope,
      type: "user",
      message: { role: "user", content: "some result text" },
      toolUseResult: { some: "result" },
      origin: { kind: "human" },
    },
    false,
  ],
  [
    "content array containing a non-object block (null), origin human — true, and must not throw",
    {
      ...baseEnvelope,
      type: "user",
      message: { role: "user", content: [null, { type: "text", text: "hi" }] },
      origin: { kind: "human" },
    },
    true,
  ],
  [
    "isMeta true, origin human — false",
    {
      ...baseEnvelope,
      type: "user",
      message: { role: "user", content: "meta text" },
      isMeta: true,
      origin: { kind: "human" },
    },
    false,
  ],
  [
    "origin.kind === task-notification (real value seen on disk) — false",
    {
      ...baseEnvelope,
      type: "user",
      message: { role: "user", content: "hi" },
      origin: { kind: "task-notification" },
    },
    false,
  ],
  [
    // [].every(...) is vacuously true, so an empty content array is treated
    // as "all tool_result" and rejected even when origin.kind === "human".
    "empty content array with origin human — false (vacuous all-tool_result)",
    {
      ...baseEnvelope,
      type: "user",
      message: { role: "user", content: [] },
      origin: { kind: "human" },
    },
    false,
  ],
];

describe("isHumanTurn", () => {
  it.each(cases)("%s", (_name, line, expected) => {
    expect(isHumanTurn(line)).toBe(expected);
  });
});

describe("isUserLine", () => {
  const userLineCases: Array<[string, TranscriptLine, boolean]> = [
    ["a user line", GENUINE_HUMAN_TURN, true],
    ["a system line", { ...baseEnvelope, type: "system" }, false],
    ["an assistant line", { ...baseEnvelope, type: "assistant" }, false],
    ["an other line", { ...baseEnvelope, type: "summary" }, false],
  ];

  it.each(userLineCases)("%s -> %s", (_name, line, expected) => {
    expect(isUserLine(line)).toBe(expected);
  });
});

describe("parseLine", () => {
  it("parses a valid known-type line as 'parsed'", () => {
    const result = parseLine(JSON.stringify({ ...baseEnvelope, type: "system" }));
    expect(result.status).toBe("parsed");
  });

  it("marks bad JSON as 'malformed', never throwing", () => {
    expect(() => parseLine("{not json")).not.toThrow();
    const result = parseLine("{not json");
    expect(result.status).toBe("malformed");
  });

  it("marks JSON with no recognisable envelope or type as 'malformed'", () => {
    const result = parseLine(JSON.stringify({ uuid: "only-this-field" }));
    expect(result.status).toBe("malformed");
  });

  it("marks a known-type line that fails its schema as 'malformed'", () => {
    // type: "user" but message.role is wrong — a known type failing its own schema.
    const result = parseLine(
      JSON.stringify({ ...baseEnvelope, type: "user", message: { role: "not-user", content: "hi" } }),
    );
    expect(result.status).toBe("malformed");
  });

  it("marks a truncated final line as 'malformed'", () => {
    const truncated = JSON.stringify({ ...baseEnvelope, type: "system" }).slice(0, -5);
    const result = parseLine(truncated);
    expect(result.status).toBe("malformed");
  });

  // Real sidecar records (02-ingestion.md, requirements v2 / R2, R7): valid
  // JSON, no envelope at all, a type ingestion doesn't handle. These must
  // parse as "ignored", not "malformed" — that was the ~32% miscount.
  const sidecarCases: Array<[string, string]> = [
    ["mode", '{"type":"mode","mode":"normal","sessionId":"1e55648c-e427-4226-b7ea-38d38ec829f3"}'],
    [
      "ai-title",
      '{"type":"ai-title","aiTitle":"Choose between Vitest 2 and Vitest 4","sessionId":"871a80ff-b180-4685-a198-30363d0d404b"}',
    ],
    [
      "bridge-session",
      '{"type":"bridge-session","sessionId":"s1","bridgeSessionId":"cse_01LGwBBm4Vg3hvTLUs4YrqFH","lastSequenceNum":0}',
    ],
    [
      "file-history-snapshot",
      '{"type":"file-history-snapshot","messageId":"4083374c-1111","snapshot":{},"isSnapshotUpdate":false}',
    ],
  ];

  it.each(sidecarCases)("parses a real %s sidecar line as 'ignored', not 'malformed'", (_name, raw) => {
    const result = parseLine(raw);
    expect(result.status).toBe("ignored");
  });
});
