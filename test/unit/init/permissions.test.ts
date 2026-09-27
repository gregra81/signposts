// The allow rules setup adds so a run never stops for a permission prompt
// (src/core/init/permissions.ts, 19-value-to-a-user.md "Fewer human steps").

import { describe, expect, it } from "vitest";
import { allowRulesFor, planPermissions } from "../../../src/core/init/permissions.js";

const REPLIES = "/home/dana/.signposts/abc123/replies.json";
const RULES = allowRulesFor(REPLIES);

describe("allowRulesFor", () => {
  it("allows the binary and the one replies file, named as an absolute path", () => {
    expect(RULES).toEqual(["Bash(signpost *)", "Edit(//home/dana/.signposts/abc123/replies.json)"]);
  });
});

describe("planPermissions", () => {
  it("adds both rules to a file with no permissions", () => {
    expect(planPermissions({}, RULES)).toEqual({
      settings: { permissions: { allow: RULES } },
      added: RULES,
    });
  });

  it("keeps the developer's rules and their other permission fields, and appends ours", () => {
    const settings = { model: "opus", permissions: { allow: ["Bash(npm test)"], deny: ["Read(./.env)"] } };

    expect(planPermissions(settings, RULES)).toEqual({
      settings: {
        model: "opus",
        permissions: { allow: ["Bash(npm test)", ...RULES], deny: ["Read(./.env)"] },
      },
      added: RULES,
    });
  });

  it("adds only what is missing", () => {
    const settings = { permissions: { allow: [RULES[0]!] } };

    expect(planPermissions(settings, RULES)).toEqual({
      settings: { permissions: { allow: RULES } },
      added: [RULES[1]],
    });
  });

  it("returns the same settings, untouched, when both are there", () => {
    const settings = { permissions: { allow: [...RULES] } };
    const plan = planPermissions(settings, RULES);

    expect(plan.added).toEqual([]);
    expect(plan.settings).toBe(settings);
  });

  it.each([
    ["null", null],
    ["a string", "all"],
  ])("treats permissions that are %s as none", (_name, permissions) => {
    expect(planPermissions({ permissions }, RULES).settings).toEqual({ permissions: { allow: RULES } });
  });

  it("treats an allow list that is not a list as empty", () => {
    expect(planPermissions({ permissions: { allow: "Bash" } }, RULES).settings).toEqual({
      permissions: { allow: RULES },
    });
  });
});
