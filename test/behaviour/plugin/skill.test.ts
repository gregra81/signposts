// The skill is the only description of the run loop the user's session ever
// sees, so it has to name the commands that exist and the halt a run stops on.
// A skill that has drifted from the CLI fails mid-run, with half a session
// extracted.
//
// It ships in the plugin now (skills/signposts/SKILL.md), pinned to the same
// release as the CLI, rather than being written into each repo by `init` —
// which left the developer a file to commit before anything had happened
// (19-value-to-a-user.md, "Fewer human steps").

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MODEL_REQUEST_KIND } from "../../../src/graph/host-model.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SKILL = readFileSync(path.join(PROJECT_ROOT, "skills", "signposts", "SKILL.md"), "utf8");

describe("the plugin's skill", () => {
  it("carries the frontmatter a skill is recognised by", () => {
    expect(SKILL.startsWith("---\nname: signposts\n")).toBe(true);
    expect(SKILL).toContain("description:");
  });

  it.each([
    "signpost sessions",
    "signpost run --session",
    "signpost resume --session",
    "--content-hash",
    "--replies",
    "--first",
    "signpost publish",
  ])("names %s", (fragment) => {
    expect(SKILL).toContain(fragment);
  });

  it("tells the session to pass on a re-extraction", () => {
    expect(SKILL).toContain("reExtracted");
  });

  it("keeps the run out of the user's context", () => {
    expect(SKILL).toContain("subagent");
  });

  it("says answers are keyed by pending id", () => {
    expect(SKILL).toContain('"replies"');
  });

  // Each session classifies against what the earlier ones proposed, which only
  // holds in order. "One per session" alone was read as "all at once".
  it("runs the sessions one at a time", () => {
    expect(SKILL).toContain("one session at a time");
    expect(SKILL).toContain("Never run sessions");
  });

  // Open item 17: "a JSON file" sent a subagent to /tmp, a heredoc and the
  // repo root. The output names the one path setup allowed.
  it("writes the replies where the output says, with the Write tool", () => {
    expect(SKILL).toContain("`repliesPath` the output names, with the Write tool");
  });

  // The yes to the offer covers the pull request; nothing else is asked.
  it("publishes at the end without asking again", () => {
    expect(SKILL).toContain("Do not ask them anything else");
    expect(SKILL).not.toMatch(/ask (?:them )?whether to publish/i);
  });

  // The live walkthrough: the session read the skill's base directory as the
  // repo, and the subagent ran `cd <plugin dir> && signpost run`, which the
  // allow rule does not match and which works on the wrong repository.
  it("says the repo is the working directory, and to run signpost bare", () => {
    expect(SKILL).toContain("The repo is the current working directory");
    expect(SKILL).toContain("no `cd`, no `&&`");
  });

  // The live walkthrough's second prompt: the subagent was told to read this
  // file, which sits in the plugin's directory, outside the project.
  it("has the instructions passed inline, not read from the plugin's directory", () => {
    expect(SKILL).toContain("Do not point it at this file");
  });

  it("never mentions the review halt that went", () => {
    expect(SKILL).not.toContain("human_review");
    expect(SKILL).not.toContain("signpost review");
    expect(MODEL_REQUEST_KIND).toBe("model_call");
  });
});
