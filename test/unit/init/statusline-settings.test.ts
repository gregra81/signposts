// What `init` does to a `statusLine` that is already there. The file IO is
// src/io/init/statusline-file.ts and is exercised in test/behaviour/cli.

import { describe, expect, it } from "vitest";
import {
  ourCommand,
  planStatusLine,
  shellQuote,
  unwrap,
  type Settings,
} from "../../../src/core/init/statusline-settings.ts";
import { STATUSLINE_REFRESH_SECONDS } from "../../../src/core/config/constants.ts";

const SCRIPT = "/opt/signposts/statusline/statusline.js";
const THEIRS = "~/.claude/statusline.sh";

describe("shellQuote", () => {
  it("quotes a plain command", () => {
    expect(shellQuote("echo hi")).toBe("'echo hi'");
  });

  // The one escape a single-quoted shell word admits. A command carrying an
  // apostrophe is otherwise a syntax error in the wrapper's shell.
  it("closes, escapes and reopens around an embedded quote", () => {
    expect(shellQuote("echo it's fine")).toBe(`'echo it'\\''s fine'`);
  });

  it("leaves what the shell would otherwise expand alone", () => {
    expect(shellQuote("echo $HOME `date`")).toBe("'echo $HOME `date`'");
  });
});

describe("unwrap", () => {
  it("is undefined for a command that wraps nothing", () => {
    expect(unwrap(ourCommand(SCRIPT))).toBeUndefined();
  });

  it("recovers exactly what was wrapped", () => {
    expect(unwrap(ourCommand(SCRIPT, THEIRS))).toBe(THEIRS);
  });

  it("survives a round trip through the quoting", () => {
    const awkward = `jq -r '"\\(.model.display_name)"'`;
    expect(unwrap(ourCommand(SCRIPT, awkward))).toBe(awkward);
  });

  // A hand-edited entry is still someone's command. Trimming characters off it
  // to force it into the expected shape would break the line it describes.
  it("hands back an unquoted tail as it stands", () => {
    expect(unwrap(`node ${SCRIPT} --wrap mystatus`)).toBe("mystatus");
  });

  it("ignores whitespace a hand edit left around it", () => {
    expect(unwrap(`node ${SCRIPT} --wrap 'mine' `)).toBe("mine");
  });

  it("hands back a half-quoted tail rather than trimming a character off it", () => {
    expect(unwrap(`node ${SCRIPT} --wrap mine'`)).toBe("mine'");
    expect(unwrap(`node ${SCRIPT} --wrap 'mine`)).toBe("'mine");
  });

  // A lone quote is startsWith and endsWith at once. Unquoting it would hand
  // back an empty command, which is a status line that renders nothing.
  it("hands back a lone quote as it stands", () => {
    expect(unwrap(`node ${SCRIPT} --wrap '`)).toBe("'");
  });

  it("is undefined when the flag carries nothing", () => {
    expect(unwrap(`node ${SCRIPT} --wrap `)).toBeUndefined();
  });
});

describe("planStatusLine", () => {
  it("installs ours when the slot is empty, with a refresh so a run is visible", () => {
    const plan = planStatusLine({}, SCRIPT);

    expect(plan.outcome).toBe("installed");
    expect(plan.settings.statusLine).toEqual({
      type: "command",
      command: `node '${SCRIPT}'`,
      refreshInterval: STATUSLINE_REFRESH_SECONDS,
    });
    expect(plan.wrapped).toBeUndefined();
  });

  it("leaves every other setting where it was", () => {
    const settings: Settings = { permissions: { allow: ["Bash"] } };
    expect(planStatusLine(settings, SCRIPT).settings.permissions).toEqual({ allow: ["Bash"] });
  });

  // The point of the module: a status line someone built is not ours to take.
  it("wraps a status line that is already there", () => {
    const plan = planStatusLine(
      { statusLine: { type: "command", command: THEIRS } },
      SCRIPT,
    );

    expect(plan.outcome).toBe("wrapped");
    expect(plan.wrapped).toBe(THEIRS);
    expect(plan.settings.statusLine?.command).toBe(`node '${SCRIPT}' --wrap '${THEIRS}'`);
  });

  it("keeps the fields around a wrapped command, and does not pace it for them", () => {
    const plan = planStatusLine(
      { statusLine: { type: "command", command: THEIRS, padding: 2 } },
      SCRIPT,
    );

    expect(plan.settings.statusLine?.padding).toBe(2);
    expect(plan.settings.statusLine).not.toHaveProperty("refreshInterval");
  });

  // An upgrade moves the script. Re-running `init` has to follow it without
  // wrapping the previous install inside the new one.
  it("updates our own entry in place rather than nesting it", () => {
    const installed = planStatusLine({ statusLine: { type: "command", command: THEIRS } }, "/old/statusline/statusline.js");
    const again = planStatusLine(installed.settings, SCRIPT);

    expect(again.outcome).toBe("updated");
    expect(again.settings.statusLine?.command).toBe(`node '${SCRIPT}' --wrap '${THEIRS}'`);
  });

  it("keeps ours alone when it wrapped nothing", () => {
    const installed = planStatusLine({}, "/old/statusline/statusline.js");
    const again = planStatusLine(installed.settings, SCRIPT);

    expect(again.settings.statusLine?.command).toBe(`node '${SCRIPT}'`);
    expect(again.wrapped).toBeUndefined();
  });

  it("treats an entry with no usable command as an empty slot", () => {
    const plan = planStatusLine({ statusLine: { type: "command", command: "" } }, SCRIPT);
    expect(plan.outcome).toBe("installed");
  });

  // Settings files are hand-written, and every shape that is not a command is
  // one we have nothing to wrap.
  it("treats a statusLine that is not an object as an empty slot", () => {
    const plan = planStatusLine({ statusLine: "echo hi" } as unknown as Settings, SCRIPT);

    expect(plan.outcome).toBe("installed");
    expect(plan.settings.statusLine?.command).toBe(`node '${SCRIPT}'`);
  });

  // `typeof null === "object"`, so this is the one shape the type check waves
  // through and then throws on.
  it("treats a null statusLine as an empty slot", () => {
    const plan = planStatusLine({ statusLine: null } as unknown as Settings, SCRIPT);
    expect(plan.outcome).toBe("installed");
  });

  it("treats an entry whose command is not a string as an empty slot", () => {
    const plan = planStatusLine(
      { statusLine: { type: "command", command: 42 } } as unknown as Settings,
      SCRIPT,
    );

    expect(plan.outcome).toBe("installed");
  });
});
