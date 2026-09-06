// The pull request as text.
//
// The body is the reviewer's whole context — it has to say what changed, why
// signposts thinks so, and which session it came from, for every session on
// the branch rather than only the last one.

import { describe, expect, it } from "vitest";
import {
  commitMessage,
  prBody,
  prLabels,
  prSection,
  PR_LABEL,
  PR_LABEL_CONTRADICTION,
} from "../../../src/core/pr/body.js";
import type { Operation } from "../../../src/core/contracts/graph.js";
import type { Signpost } from "../../../src/core/signpost/schema.js";

function signpost(overrides: Partial<Signpost> = {}): Signpost {
  return {
    id: "staging-read-only",
    claim: "Staging is read only outside the ETL window",
    category: "environment",
    scope: { repo: "acme/api" },
    evidence: "A migration failed with a permissions error.",
    confidence: 0.9,
    provenance: {
      session_ids: ["sess-1"],
      authors: ["dev@acme.example"],
      first_seen: "2026-01-01",
      last_reinforced: "2026-01-01",
    },
    status: "active",
    ...overrides,
  };
}

const ADD: Operation = { op: "add", signpost: signpost() };
const REINFORCE: Operation = {
  op: "reinforce",
  id: "staging-read-only",
  sessionId: "sess-2",
  author: "dev@acme.example",
};
const SUPERSEDE: Operation = {
  op: "supersede",
  id: "staging-read-only",
  replacement: signpost({ id: "staging-writable", claim: "Staging accepts writes in the window" }),
};

describe("prSection", () => {
  it("names the session and carries the claim and the evidence", () => {
    const section = prSection("sess-1", [ADD]);

    expect(section).toContain("sess-1");
    expect(section).toContain(signpost().claim);
    expect(section).toContain(signpost().evidence);
  });

  it("shows a supersede as the swap it is", () => {
    expect(prSection("sess-1", [SUPERSEDE])).toContain("staging-read-only → staging-writable");
  });

  it("gives a row to an operation that carries no claim of its own", () => {
    const section = prSection("sess-1", [REINFORCE]);

    expect(section).toContain(
      "| reinforce | staging-read-only | another session said the same thing |  |",
    );
  });

  it("shows a refine's new claim and evidence", () => {
    const section = prSection("sess-1", [
      { op: "refine", id: "staging-read-only", claim: "Staging is read only always", evidence: "Asked ops." },
    ]);

    expect(section).toContain("| refine | staging-read-only | Staging is read only always | Asked ops. |");
  });

  it("says so when a refine only narrows the scope", () => {
    const section = prSection("sess-1", [
      { op: "refine", id: "staging-read-only", scope: { repo: "acme/api", paths: ["db/**"] } },
    ]);

    expect(section).toContain("| refine | staging-read-only | (scope only) |  |");
  });

  it("opens the table with a header row", () => {
    expect(prSection("sess-1", [ADD])).toContain("| op | signpost | claim | why |");
  });

  it("headings name the session", () => {
    expect(prSection("sess-7", [ADD])).toContain("### Session `sess-7`");
  });

  it("says so when a session proposed nothing, rather than leaving a bare heading", () => {
    expect(prSection("sess-9", [])).toContain("Nothing proposed.");
  });

  it("gives every operation its own row", () => {
    const rows = prSection("sess-1", [ADD, REINFORCE])
      .split("\n")
      .filter((line) => line.startsWith("| add") || line.startsWith("| reinforce"));

    expect(rows).toHaveLength(2);
  });

  it("flattens a newline so one evidence line cannot break the table", () => {
    const section = prSection("sess-1", [
      { op: "add", signpost: signpost({ evidence: "First line.\nSecond line." }) },
    ]);

    expect(section).toContain("First line. Second line.");
    expect(section.split("\n").filter((line) => line.startsWith("| add"))).toHaveLength(1);
  });

  it("escapes a pipe so one claim cannot break the table", () => {
    const section = prSection("sess-1", [
      { op: "add", signpost: signpost({ claim: "Use a | between fields" }) },
    ]);

    expect(section).toContain("Use a \\| between fields");
  });
});

describe("prBody", () => {
  it("opens a new body with what the PR is", () => {
    const body = prBody("", prSection("sess-1", [ADD]));

    expect(body).toContain("Nothing here is merged automatically.");
    expect(body).toContain("sess-1");
  });

  it("appends to what earlier sessions wrote", () => {
    const first = prBody("", prSection("sess-1", [ADD]));
    const second = prBody(first, prSection("sess-2", [REINFORCE]));

    expect(second.indexOf("sess-1")).toBeLessThan(second.indexOf("sess-2"));
    expect(second).toContain("sess-1");
  });

  it("does not leave a growing gap when the existing body ends in whitespace", () => {
    const body = prBody("## Proposed\n\nsomething\n\n\n   ", prSection("sess-2", [ADD]));

    expect(body).not.toMatch(/\n{3}/);
  });

  it("keeps the heading a body opens with", () => {
    expect(prBody("", prSection("sess-1", [ADD])).startsWith("## Proposed")).toBe(true);
  });

  it("does not repeat the preamble on every update", () => {
    const first = prBody("", prSection("sess-1", [ADD]));
    const second = prBody(first, prSection("sess-2", [ADD]));

    expect(second.split("Nothing here is merged automatically.")).toHaveLength(2);
  });
});

describe("prLabels", () => {
  it("labels every PR", () => {
    expect(prLabels([ADD])).toEqual([PR_LABEL]);
  });

  it("flags a PR that replaces recorded knowledge", () => {
    expect(prLabels([ADD, SUPERSEDE])).toEqual([PR_LABEL, PR_LABEL_CONTRADICTION]);
  });
});

describe("commitMessage", () => {
  it("says how much came from which session", () => {
    expect(commitMessage("01J9F", [ADD, REINFORCE])).toBe("signposts: 2 from session 01J9F");
  });
});
