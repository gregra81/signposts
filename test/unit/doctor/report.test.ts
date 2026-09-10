import { describe, expect, it } from "vitest";
import {
  buildDoctorReport,
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
  hookInstalled: false,
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

describe("buildDoctorReport", () => {
  it("reports every fact as one line, in order", () => {
    const lines = buildDoctorReport(BASE_FACTS);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain("node:");
    expect(lines[1]).toContain("gh:");
    expect(lines[2]).toContain("embedding model cache:");
    expect(lines[3]).toContain("database:");
    expect(lines[4]).toContain("session-start hook:");
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
    expect(lines[1]).toContain("not found");
  });

  it("gh installed, not authenticated", () => {
    const lines = buildDoctorReport({ ...BASE_FACTS, gh: { installed: true, authenticated: false } });
    expect(lines[1]).toContain("not authenticated");
  });

  it("gh installed and authenticated", () => {
    const lines = buildDoctorReport({ ...BASE_FACTS, gh: { installed: true, authenticated: true } });
    expect(lines[1]).toBe("gh: authenticated");
  });

  it.each([
    ["warm", "warm"],
    ["cold", "cold"],
    ["vendored", "vendored"],
    ["unavailable", "unavailable"],
  ] as const)("model cache %s", (status, expected) => {
    expect(buildDoctorReport({ ...BASE_FACTS, modelCache: status })[2]).toContain(expected);
  });

  it.each([
    ["no-database", "database: no database yet"],
    ["ok", "database: ok"],
    ["corrupt", "database: integrity check failed"],
  ] as const)("db integrity %s", (status, expected) => {
    const line = buildDoctorReport({ ...BASE_FACTS, dbIntegrity: status })[3];
    expect(line).toBe(expected);
  });

  it("hook installed vs not", () => {
    expect(buildDoctorReport({ ...BASE_FACTS, hookInstalled: true })[4]).toBe("session-start hook: installed");
    expect(buildDoctorReport({ ...BASE_FACTS, hookInstalled: false })[4]).toBe("session-start hook: not installed");
  });
});
