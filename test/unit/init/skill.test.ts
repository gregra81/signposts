// The skill is the only description of the run loop the user's session ever
// sees, so it has to name the commands that exist and both halts a run can
// stop on. A skill that has drifted from the CLI fails mid-run, with half a
// session extracted.

import { describe, expect, it } from "vitest";
import { SKILL_DIR, SKILL_DOC, SKILL_FILENAME } from "../../../src/core/init/skill.js";
import { MODEL_REQUEST_KIND } from "../../../src/graph/host-model.js";
import { REVIEW_REQUEST_KIND } from "../../../src/graph/nodes/human-review.js";

describe("the installed skill", () => {
  it("goes where Claude Code looks for skills", () => {
    expect(SKILL_DIR).toBe(".claude/skills/signposts");
    expect(SKILL_FILENAME).toBe("SKILL.md");
  });

  it("carries the frontmatter a skill is recognised by", () => {
    expect(SKILL_DOC.startsWith("---\nname: signposts\n")).toBe(true);
    expect(SKILL_DOC).toContain("description:");
  });

  it.each([
    "signpost sessions",
    "signpost run --session",
    "signpost resume --session",
    "--content-hash",
    "--replies",
    "--first",
  ])(
    "names %s",
    (fragment) => {
      expect(SKILL_DOC).toContain(fragment);
    },
  );

  it("tells the session to pass on a re-extraction", () => {
    expect(SKILL_DOC).toContain("reExtracted");
  });

  it("tells both halts apart by the kinds the graph actually sends", () => {
    expect(SKILL_DOC).toContain(MODEL_REQUEST_KIND);
    expect(SKILL_DOC).toContain(REVIEW_REQUEST_KIND);
  });

  it("keeps the run out of the user's context and the review in it", () => {
    expect(SKILL_DOC).toContain("subagent");
    expect(SKILL_DOC).toContain("Return to the main session");
  });

  it("says answers are keyed by pending id", () => {
    expect(SKILL_DOC).toContain('"replies"');
  });

  // Each session classifies against what the earlier ones proposed, which only
  // holds in order. "One per session" alone was read as "all at once".
  it("runs the sessions one at a time", () => {
    expect(SKILL_DOC).toContain("one session at a time");
    expect(SKILL_DOC).toContain("Never run sessions in");
  });
});
