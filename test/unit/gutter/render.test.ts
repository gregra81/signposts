import { describe, expect, it } from "vitest";
import { renderGutteredSession } from "../../../src/core/gutter/render.js";
import type { GutteredSession, GutteredTurn } from "../../../src/core/gutter/types.js";

function session(turns: GutteredTurn[]): GutteredSession {
  return {
    sessionId: "s1",
    contentHash: "abc",
    repo: "acme/api",
    repoRoot: "/repo",
    startedAt: "2026-08-27T09:00:00.000Z",
    lastActivityAt: "2026-08-27T10:00:00.000Z",
    turns,
    tokenEstimate: 120,
    redactionCount: 0,
  };
}

describe("renderGutteredSession", () => {
  // The whole extraction rests on knowing which words are the human's.
  it("labels each turn with its speaker", () => {
    expect(
      renderGutteredSession(
        session([
          { role: "human", text: "no, staging is read only", at: "t1" },
          { role: "assistant", text: "Understood.", at: "t2" },
        ]),
      ),
    ).toBe("human: no, staging is read only\nassistant: Understood.");
  });

  it("annotates tool names when present", () => {
    expect(
      renderGutteredSession(
        session([{ role: "assistant", text: "Reading.", toolNames: ["Read", "Grep"], at: "t1" }]),
      ),
    ).toBe("assistant: Reading. [tools: Read, Grep]");
  });

  it("annotates touched files when present", () => {
    expect(
      renderGutteredSession(
        session([{ role: "assistant", text: "Editing.", filesTouched: ["src/a.ts"], at: "t1" }]),
      ),
    ).toBe("assistant: Editing. [files: src/a.ts]");
  });

  it("separates several touched files", () => {
    expect(
      renderGutteredSession(
        session([
          { role: "assistant", text: "Editing.", filesTouched: ["src/a.ts", "src/b.ts"], at: "t1" },
        ]),
      ),
    ).toBe("assistant: Editing. [files: src/a.ts, src/b.ts]");
  });

  it("annotates both, tools first", () => {
    expect(
      renderGutteredSession(
        session([
          { role: "assistant", text: "Working.", toolNames: ["Edit"], filesTouched: ["src/a.ts"], at: "t1" },
        ]),
      ),
    ).toBe("assistant: Working. [tools: Edit | files: src/a.ts]");
  });

  it("adds no annotation block for empty arrays", () => {
    expect(
      renderGutteredSession(
        session([{ role: "human", text: "hi", toolNames: [], filesTouched: [], at: "t1" }]),
      ),
    ).toBe("human: hi");
  });

  it("renders an empty session as an empty string", () => {
    expect(renderGutteredSession(session([]))).toBe("");
  });

  it("preserves turn order", () => {
    expect(
      renderGutteredSession(
        session([
          { role: "human", text: "first", at: "t1" },
          { role: "human", text: "second", at: "t2" },
        ]),
      ),
    ).toBe("human: first\nhuman: second");
  });
});
