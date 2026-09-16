import { describe, expect, it } from "vitest";
import {
  blockers,
  buildDoctorReport,
  detectSignpostPlugin,
  classifyDbIntegrity,
  classifyModelCache,
  detectSignpostSessionStartHook,
  isNodeVersionSupported,
  type DoctorFacts,
} from "../../../src/core/doctor/report.js";

const BASE_FACTS: DoctorFacts = {
  nodeMajorVersion: 24,
  nodeMinVersion: 24,
  gh: { installed: false, authenticated: false },
  modelCache: "cold",
  dbIntegrity: "no-database",
  hook: "absent",
  git: { authorEmail: "greg@example.com", repo: "acme/api" },
  consent: "given",
  statusLine: { state: "ok" },
  lastError: null,
};

describe("isNodeVersionSupported", () => {
  it("at floor is supported", () => {
    expect(isNodeVersionSupported(24, 24)).toBe(true);
  });
  it("above floor is supported", () => {
    expect(isNodeVersionSupported(25, 24)).toBe(true);
  });
  it("below floor is not supported", () => {
    expect(isNodeVersionSupported(23, 24)).toBe(false);
  });
});

describe("classifyModelCache", () => {
  it("the pinned revision in the shared cache is warm", () => {
    expect(classifyModelCache({ vendored: false, pinnedRevisionCached: true, remoteAllowed: true })).toBe("warm");
  });

  it("nothing on disk, but the download is allowed: cold", () => {
    expect(classifyModelCache({ vendored: false, pinnedRevisionCached: false, remoteAllowed: true })).toBe("cold");
  });

  // The restricted-network setup of story 57, minus the vendored copy it
  // needs: transformers.js throws rather than downloading, so calling this
  // cold would promise a download that cannot happen.
  it("nothing on disk and no route to the model host: unavailable, not cold", () => {
    expect(classifyModelCache({ vendored: false, pinnedRevisionCached: false, remoteAllowed: false })).toBe(
      "unavailable",
    );
  });

  it("a warm cache is warm whatever the remote policy says", () => {
    expect(classifyModelCache({ vendored: false, pinnedRevisionCached: true, remoteAllowed: false })).toBe("warm");
  });

  it("a vendored copy wins, cached or not — transformers.js ignores the shared cache then", () => {
    expect(classifyModelCache({ vendored: true, pinnedRevisionCached: false, remoteAllowed: false })).toBe("vendored");
    expect(classifyModelCache({ vendored: true, pinnedRevisionCached: true, remoteAllowed: true })).toBe("vendored");
  });
});

describe("classifyDbIntegrity", () => {
  it("no db file -> no-database", () => {
    expect(classifyDbIntegrity(false, undefined)).toBe("no-database");
  });
  it("db exists, pragma says ok -> ok", () => {
    expect(classifyDbIntegrity(true, "ok")).toBe("ok");
  });
  it("db exists, pragma says anything else -> corrupt", () => {
    expect(classifyDbIntegrity(true, "malformed database schema")).toBe("corrupt");
  });
});

describe("detectSignpostSessionStartHook", () => {
  it("undefined/missing settings -> false", () => {
    expect(detectSignpostSessionStartHook(undefined)).toBe(false);
    expect(detectSignpostSessionStartHook(null)).toBe(false);
    expect(detectSignpostSessionStartHook({})).toBe(false);
  });

  it("no SessionStart hooks -> false", () => {
    expect(detectSignpostSessionStartHook({ hooks: {} })).toBe(false);
  });

  it("SessionStart hooks present but unrelated -> false", () => {
    expect(
      detectSignpostSessionStartHook({
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] },
      }),
    ).toBe(false);
  });

  it("SessionStart hook mentioning signpost -> true", () => {
    expect(
      detectSignpostSessionStartHook({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "node ./signpost-session-start.js" }] }],
        },
      }),
    ).toBe(true);
  });

  it("malformed shapes never throw", () => {
    expect(detectSignpostSessionStartHook("not an object")).toBe(false);
    expect(detectSignpostSessionStartHook({ hooks: null })).toBe(false);
    expect(detectSignpostSessionStartHook({ hooks: { SessionStart: "not an array" } })).toBe(false);
    expect(detectSignpostSessionStartHook({ hooks: { SessionStart: [{ hooks: "nope" }] } })).toBe(false);
    expect(detectSignpostSessionStartHook({ hooks: { SessionStart: [null] } })).toBe(false);
    expect(detectSignpostSessionStartHook({ hooks: { SessionStart: [undefined] } })).toBe(false);
    expect(detectSignpostSessionStartHook({ hooks: { SessionStart: ["not an object"] } })).toBe(false);
    expect(
      detectSignpostSessionStartHook({ hooks: { SessionStart: [{ hooks: [null] }] } }),
    ).toBe(false);
    expect(
      detectSignpostSessionStartHook({ hooks: { SessionStart: [{ hooks: [undefined] }] } }),
    ).toBe(false);
    expect(
      detectSignpostSessionStartHook({ hooks: { SessionStart: [{ hooks: ["not an object"] }] } }),
    ).toBe(false);
    expect(
      detectSignpostSessionStartHook({ hooks: { SessionStart: [{ hooks: [{}] }] } }),
    ).toBe(false);
    expect(
      detectSignpostSessionStartHook({
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: 42 }] }] },
      }),
    ).toBe(false);
  });

  it("only one of several groups/entries matching is still a hit (.some, not .every)", () => {
    expect(
      detectSignpostSessionStartHook({
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "echo unrelated" }] },
            { hooks: [{ type: "command", command: "node signpost-session-start.js" }] },
          ],
        },
      }),
    ).toBe(true);

    expect(
      detectSignpostSessionStartHook({
        hooks: {
          SessionStart: [
            {
              hooks: [
                { type: "command", command: "echo unrelated" },
                { type: "command", command: "node signpost-session-start.js" },
              ],
            },
          ],
        },
      }),
    ).toBe(true);
  });

  it("no group/entry matching is a miss even when every group/entry is otherwise well-formed", () => {
    expect(
      detectSignpostSessionStartHook({
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "echo one" }] },
            { hooks: [{ type: "command", command: "echo two" }] },
          ],
        },
      }),
    ).toBe(false);
  });
});

// 18-end-to-end-gaps.md, "Spec drift". `.claude-plugin/plugin.json` registers
// the hook through `hooks/hooks.json`, so no settings file mentions it and the
// settings check reported "not installed" to every plugin user about a hook
// firing on every session. `enabledPlugins` is the trace a plugin does leave.
describe("detectSignpostPlugin", () => {
  const enabled = (plugins: Record<string, unknown>) => ({ enabledPlugins: plugins });

  it("finds the plugin whatever marketplace it came from", () => {
    expect(detectSignpostPlugin(enabled({ "signposts@some-marketplace": true }))).toBe(true);
  });

  it("does not count one that is explicitly turned off", () => {
    expect(detectSignpostPlugin(enabled({ "signposts@some-marketplace": false }))).toBe(false);
  });

  it("does not match a different plugin whose name merely contains ours", () => {
    expect(detectSignpostPlugin(enabled({ "signposts-extras@m": true }))).toBe(false);
  });

  it.each([[undefined], [null], ["nonsense"], [{}], [{ enabledPlugins: null }]])(
    "reports absent for %s rather than throwing",
    (settings) => {
      expect(detectSignpostPlugin(settings)).toBe(false);
    },
  );
});

describe("buildDoctorReport", () => {
  it("reports every fact as one line, in order", () => {
    const lines = buildDoctorReport(BASE_FACTS);
    expect(lines).toHaveLength(11);
    expect(lines[0]).toContain("node:");
    expect(lines[1]).toContain("git author:");
    expect(lines[2]).toContain("git origin:");
    expect(lines[3]).toContain("gh:");
    expect(lines[4]).toContain("embedding model cache:");
    expect(lines[5]).toContain("database:");
    expect(lines[6]).toContain("session-start hook:");
    expect(lines[7]).toContain("consent:");
    expect(lines[8]).toContain("status line:");
    expect(lines[9]).toContain("last background error:");
    expect(lines[10]).toContain("nothing blocks");
  });

  it("node below floor is called out", () => {
    const lines = buildDoctorReport({ ...BASE_FACTS, nodeMajorVersion: 20, nodeMinVersion: 24 });
    expect(lines[0]).toContain("below floor");
  });

  it("node at or above floor is reported ok", () => {
    const lines = buildDoctorReport(BASE_FACTS);
    expect(lines[0]).toContain("— ok");
  });

  it("gh not installed", () => {
    const lines = buildDoctorReport(BASE_FACTS);
    expect(lines[3]).toContain("not found");
  });

  it("gh installed, not authenticated", () => {
    const lines = buildDoctorReport({ ...BASE_FACTS, gh: { installed: true, authenticated: false } });
    expect(lines[3]).toContain("not authenticated");
  });

  it("gh installed and authenticated", () => {
    const lines = buildDoctorReport({ ...BASE_FACTS, gh: { installed: true, authenticated: true } });
    expect(lines[3]).toBe("gh: authenticated");
  });

  it.each([
    ["warm", "warm"],
    ["cold", "cold"],
    ["vendored", "vendored"],
    ["unavailable", "unavailable"],
  ] as const)("model cache %s", (status, expected) => {
    expect(buildDoctorReport({ ...BASE_FACTS, modelCache: status })[4]).toContain(expected);
  });

  it.each([
    ["no-database", "database: no database yet"],
    ["ok", "database: ok"],
    ["corrupt", "database: integrity check failed"],
  ] as const)("db integrity %s", (status, expected) => {
    const line = buildDoctorReport({ ...BASE_FACTS, dbIntegrity: status })[5];
    expect(line).toBe(expected);
  });

  // Three states, not two. A plugin user was told "not installed" about a hook
  // firing on every session (18-end-to-end-gaps.md, "Spec drift"), and the
  // absent case now says where it looked, since `--plugin-dir` leaves no trace
  // in any settings file.
  it.each([
    ["plugin", "installed — by the signposts plugin"],
    ["settings", "installed — in a Claude Code settings file"],
    ["absent", "not found in settings or in an enabled plugin"],
  ] as const)("hook %s", (hook, expected) => {
    expect(buildDoctorReport({ ...BASE_FACTS, hook })[6]).toContain(expected);
  });

  // The remedy used to be "install the signposts plugin, or run `signpost
  // init`", and init installs no hook — so the one command the line named was
  // the one that changes nothing here. Whatever it says, it may not send a
  // person back to init.
  it("sends a missing hook to the plugin, not to init", () => {
    const line = buildDoctorReport({ ...BASE_FACTS, hook: "absent" })[6]!;

    expect(line).toContain("/plugin install signposts@signposts");
    expect(line).not.toContain("signpost init");
  });

  // 18-end-to-end-gaps.md item 7: the two failures that halt the loop outright
  // and were reported by no command that a person runs before hitting them.
  it("says which command an unset git author will stop", () => {
    const lines = buildDoctorReport({ ...BASE_FACTS, git: { authorEmail: null, repo: "acme/api" } });

    expect(lines[1]).toContain("git config user.email is not set");
    expect(lines[1]).toContain("run");
  });

  it("says which command a missing origin will stop", () => {
    const lines = buildDoctorReport({ ...BASE_FACTS, git: { authorEmail: "greg@example.com", repo: null } });

    expect(lines[2]).toContain("no 'origin' remote");
    expect(lines[2]).toContain("index");
  });
});

// 19-value-to-a-user.md items 4 and 6.
describe("the facts doctor learned to read", () => {
  it.each([
    ["given", "consent: given"],
    ["not-given", "consent: not given — run `signpost init`"],
    ["unknown", "consent: unknown — needs an origin remote and a readable database to check"],
  ] as const)("consent %s", (consent, expected) => {
    expect(buildDoctorReport({ ...BASE_FACTS, consent })[7]).toBe(expected);
  });

  it("names a status line whose script has gone, and what it costs", () => {
    const line = buildDoctorReport({
      ...BASE_FACTS,
      statusLine: { state: "missing", scriptPath: "/old/node/lib/signposts/statusline/statusline.js" },
    })[8]!;

    expect(line).toContain("/old/node/lib/signposts/statusline/statusline.js");
    // A missing script exits non-zero, which blanks the whole bar — the
    // developer's own wrapped status line with it.
    expect(line).toContain("blanks");
    expect(line).toContain("signpost init");
  });

  it.each([
    [{ state: "ok" } as const, "status line: installed"],
    [{ state: "absent" } as const, "status line: not installed by signposts"],
  ])("status line %j", (statusLine, expected) => {
    expect(buildDoctorReport({ ...BASE_FACTS, statusLine })[8]).toBe(expected);
  });

  it("reports the background worker's last error, which nothing else ever showed", () => {
    expect(buildDoctorReport({ ...BASE_FACTS, lastError: "index rebuild exited 1" })[9]).toBe(
      "last background error: index rebuild exited 1",
    );
    expect(buildDoctorReport(BASE_FACTS)[9]).toBe("last background error: none");
  });
});

describe("blockers", () => {
  it("is empty for a machine that can run", () => {
    expect(blockers(BASE_FACTS)).toEqual([]);
    expect(buildDoctorReport(BASE_FACTS)[10]).toBe("ready: nothing blocks `signpost run`");
  });

  it.each([
    [{ nodeMajorVersion: 22 }, "node below floor"],
    [{ git: { authorEmail: null, repo: "acme/api" } }, "no git author"],
    [{ git: { authorEmail: "greg@example.com", repo: null } }, "no origin remote"],
    [{ dbIntegrity: "corrupt" as const }, "database corrupt"],
    [{ consent: "not-given" as const }, "no consent"],
  ])("%j blocks a run", (override, reason) => {
    const facts = { ...BASE_FACTS, ...override };
    expect(blockers(facts)).toEqual([reason]);
    expect(buildDoctorReport(facts)[10]).toBe(`blocked: ${reason}`);
  });

  it("does not count what only degrades a run", () => {
    // Worth saying, not worth failing on: each of these leaves `run` working.
    expect(
      blockers({
        ...BASE_FACTS,
        gh: { installed: false, authenticated: false },
        modelCache: "unavailable",
        dbIntegrity: "no-database",
        hook: "absent",
        consent: "unknown",
        statusLine: { state: "missing", scriptPath: "/gone" },
        lastError: "index rebuild exited 1",
      }),
    ).toEqual([]);
  });

  it("lists every blocker, not only the first", () => {
    const facts = { ...BASE_FACTS, git: { authorEmail: null, repo: null }, consent: "unknown" as const };
    expect(buildDoctorReport(facts)[10]).toBe("blocked: no git author, no origin remote");
  });
});
