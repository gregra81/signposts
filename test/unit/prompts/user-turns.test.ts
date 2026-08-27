import { describe, expect, it } from "vitest";
import {
  classifyUserTurn,
  criticUserTurn,
  EXTRACT_RETRY_INSTRUCTION,
  EXTRACT_RETRY_PREAMBLE,
  extractUserTurn,
  formatCritique,
  resolveUserTurn,
} from "../../../src/core/prompts/user-turns.js";
import type { Candidate } from "../../../src/core/contracts/graph.js";
import type { Signpost } from "../../../src/core/signpost/schema.js";

const CANDIDATE: Candidate = {
  tempId: "t1",
  claim: "Staging is read only",
  category: "environment",
  scope: { repo: "acme/api" },
  evidence: "Stated after a failed write.",
  confidence: 0.9,
  hedged: false,
};

const NEIGHBOUR: Signpost = {
  id: "staging-read-only",
  claim: "Staging is writable for the ETL job",
  category: "environment",
  scope: { repo: "acme/api" },
  evidence: "From an earlier session.",
  confidence: 0.8,
  provenance: {
    session_ids: ["s0"],
    authors: ["dev@acme.example"],
    first_seen: "2026-01-01",
    last_reinforced: "2026-01-01",
  },
  status: "active",
};

describe("extractUserTurn", () => {
  it("matches 14-prompts.md's template on a first attempt", () => {
    expect(extractUserTurn({ repo: "acme/api", guttered: "human: no, staging is read only" })).toBe(
      "Repository: acme/api\n\nTranscript:\nhuman: no, staging is read only",
    );
  });

  it("appends the retry block when a critique is present", () => {
    const turn = extractUserTurn({
      repo: "acme/api",
      guttered: "human: hi",
      critique: "- Too vague\n  rejected: not actionable",
    });
    expect(turn).toContain(EXTRACT_RETRY_PREAMBLE);
    expect(turn).toContain("- Too vague");
    expect(turn).toContain(EXTRACT_RETRY_INSTRUCTION);
  });

  it("keeps the transcript block ahead of the retry block", () => {
    const turn = extractUserTurn({ repo: "acme/api", guttered: "human: hi", critique: "c" });
    expect(turn.indexOf("Transcript:")).toBeLessThan(turn.indexOf(EXTRACT_RETRY_PREAMBLE));
  });

  it("omits the retry block entirely when critique is undefined", () => {
    const turn = extractUserTurn({ repo: "acme/api", guttered: "human: hi", critique: undefined });
    expect(turn).not.toContain(EXTRACT_RETRY_PREAMBLE);
  });
});

describe("criticUserTurn", () => {
  it("matches 14-prompts.md's template", () => {
    expect(criticUserTurn("acme/api", [CANDIDATE])).toBe(
      `Repository: acme/api\n\nCandidates:\n${JSON.stringify([CANDIDATE])}`,
    );
  });

  it("renders an empty batch as an empty array", () => {
    expect(criticUserTurn("acme/api", [])).toContain("Candidates:\n[]");
  });
});

describe("classifyUserTurn", () => {
  it("matches 14-prompts.md's template", () => {
    expect(classifyUserTurn(CANDIDATE, [NEIGHBOUR])).toBe(
      `Candidate:\n${JSON.stringify(CANDIDATE)}\n\nExisting neighbours:\n${JSON.stringify([NEIGHBOUR])}`,
    );
  });

  // No neighbours is a real case — retrieval never pads to k.
  it("renders an empty neighbour list rather than omitting the section", () => {
    expect(classifyUserTurn(CANDIDATE, [])).toContain("Existing neighbours:\n[]");
  });

  it("carries no repository line — classify's input is deliberately minimal", () => {
    expect(classifyUserTurn(CANDIDATE, [])).not.toContain("Repository:");
  });
});

describe("resolveUserTurn", () => {
  it("matches 14-prompts.md's template", () => {
    expect(resolveUserTurn("acme/api", CANDIDATE, NEIGHBOUR)).toBe(
      `Repository: acme/api\n\nNew claim:\n${JSON.stringify(CANDIDATE)}\n\nExisting claim:\n${JSON.stringify(NEIGHBOUR)}`,
    );
  });

  it("puts the new claim before the existing one", () => {
    const turn = resolveUserTurn("acme/api", CANDIDATE, NEIGHBOUR);
    expect(turn.indexOf("New claim:")).toBeLessThan(turn.indexOf("Existing claim:"));
  });
});

describe("formatCritique", () => {
  it("renders one line per rejection with its reason", () => {
    expect(
      formatCritique([
        { claim: "We refactored auth", reason: "session summary, not knowledge" },
        { claim: "Be careful", reason: "too vague to act on" },
      ]),
    ).toBe(
      "- We refactored auth\n  rejected: session summary, not knowledge\n" +
        "- Be careful\n  rejected: too vague to act on",
    );
  });

  it("renders nothing for no rejections", () => {
    expect(formatCritique([])).toBe("");
  });
});
