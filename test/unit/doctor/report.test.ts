import { describe, expect, it } from "vitest";
import {
  buildDoctorReport,
  classifyDbIntegrity,
  detectSignpostSessionStartHook,
  isNodeVersionSupported,
  type CredentialFact,
  type DoctorFacts,
} from "../../../src/core/doctor/report.js";
import { AUTH_CHAIN, SHARED_QUOTA_TIER } from "../../../src/core/config/constants.js";

const [SUBSCRIPTION, API_KEY, AUTH_TOKEN] = AUTH_CHAIN;

const NO_CREDENTIAL: CredentialFact = {
  selected: "none",
  usable: [],
  subscriptionType: undefined,
  rateLimitTier: undefined,
  subscriptionExpired: false,
  pinned: false,
};

/** The credentials line, wherever it landed — the report can insert an advisory after it. */
function credentialLine(lines: string[]): string {
  const line = lines.find((candidate) => candidate.startsWith("credentials:"));
  if (line === undefined) {
    throw new Error(`no credentials line in report:\n${lines.join("\n")}`);
  }
  return line;
}

const BASE_FACTS: DoctorFacts = {
  nodeMajorVersion: 24,
  nodeMinVersion: 24,
  credential: NO_CREDENTIAL,
  gh: { installed: false, authenticated: false },
  modelCachePresent: false,
  dbIntegrity: "no-database",
  hookInstalled: false,
};

describe("credential reporting", () => {
  it("names the selected method", () => {
    const lines = buildDoctorReport({
      ...BASE_FACTS,
      credential: { ...NO_CREDENTIAL, selected: API_KEY, usable: [API_KEY] },
    });
    expect(credentialLine(lines)).toBe(`credentials: ${API_KEY}`);
  });

  it("lists the other usable methods alongside the selected one", () => {
    const lines = buildDoctorReport({
      ...BASE_FACTS,
      credential: {
        ...NO_CREDENTIAL,
        selected: SUBSCRIPTION,
        usable: [SUBSCRIPTION, API_KEY, AUTH_TOKEN],
      },
    });
    const line = credentialLine(lines);
    expect(line).toContain(SUBSCRIPTION);
    expect(line).toContain(`also available: ${API_KEY}, ${AUTH_TOKEN}`);
    expect(line).not.toContain(`also available: ${SUBSCRIPTION}`);
  });

  it("shows the bare method name when the subscription reports no tier", () => {
    const lines = buildDoctorReport({
      ...BASE_FACTS,
      credential: {
        ...NO_CREDENTIAL,
        selected: SUBSCRIPTION,
        usable: [SUBSCRIPTION],
        subscriptionType: undefined,
      },
    });
    expect(credentialLine(lines)).toBe(`credentials: ${SUBSCRIPTION}`);
  });

  it("never shows a subscription tier against a non-subscription method", () => {
    const lines = buildDoctorReport({
      ...BASE_FACTS,
      credential: {
        ...NO_CREDENTIAL,
        selected: API_KEY,
        usable: [API_KEY],
        subscriptionType: "pro",
      },
    });
    expect(credentialLine(lines)).toBe(`credentials: ${API_KEY}`);
  });

  it("does not warn when the subscription is on a tier of its own", () => {
    const lines = buildDoctorReport({
      ...BASE_FACTS,
      credential: {
        ...NO_CREDENTIAL,
        selected: SUBSCRIPTION,
        usable: [SUBSCRIPTION],
        rateLimitTier: "dedicated_tier",
      },
    });
    expect(lines.join("\n")).not.toContain("share the quota");
  });

  it("names the subscription tier when there is one", () => {
    const lines = buildDoctorReport({
      ...BASE_FACTS,
      credential: {
        ...NO_CREDENTIAL,
        selected: SUBSCRIPTION,
        usable: [SUBSCRIPTION],
        subscriptionType: "pro",
      },
    });
    expect(credentialLine(lines)).toBe(`credentials: ${SUBSCRIPTION} (pro)`);
  });

  it("warns that a shared-quota subscription competes with interactive Claude Code", () => {
    const lines = buildDoctorReport({
      ...BASE_FACTS,
      credential: {
        ...NO_CREDENTIAL,
        selected: SUBSCRIPTION,
        usable: [SUBSCRIPTION],
        rateLimitTier: SHARED_QUOTA_TIER,
      },
    });
    expect(lines.join("\n")).toContain("share the quota");
  });

  it("does not warn about quota for a non-subscription method", () => {
    const lines = buildDoctorReport({
      ...BASE_FACTS,
      credential: {
        ...NO_CREDENTIAL,
        selected: API_KEY,
        usable: [API_KEY],
        rateLimitTier: SHARED_QUOTA_TIER,
      },
    });
    expect(lines.join("\n")).not.toContain("share the quota");
  });

  it("tells the user to refresh an expired subscription credential", () => {
    const lines = buildDoctorReport({
      ...BASE_FACTS,
      credential: { ...NO_CREDENTIAL, subscriptionExpired: true },
    });
    expect(lines.join("\n")).toContain("expired");
  });

  it("distinguishes a pinned-but-missing method from nothing configured", () => {
    const pinned = buildDoctorReport({
      ...BASE_FACTS,
      credential: { ...NO_CREDENTIAL, pinned: true },
    });
    expect(credentialLine(pinned)).toContain("pinned");

    const unpinned = buildDoctorReport(BASE_FACTS);
    expect(credentialLine(unpinned)).not.toContain("pinned");
  });

  it("with nothing available, names every way to authenticate", () => {
    const line = credentialLine(buildDoctorReport(BASE_FACTS));
    expect(line).toContain("Claude Code");
    expect(line).toContain("ANTHROPIC_API_KEY");
    expect(line).toContain("ANTHROPIC_AUTH_TOKEN");
    expect(line).toContain("ant auth login");
  });
});

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
    expect(detectSignpostSessionStartHook({ hooks: { SessionStart: ["not an object"] } })).toBe(false);
    expect(
      detectSignpostSessionStartHook({ hooks: { SessionStart: [{ hooks: [null] }] } }),
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
    expect(lines).toHaveLength(6);
    expect(lines[0]).toContain("node:");
    expect(lines[1]).toContain("credentials:");
    expect(lines[2]).toContain("gh:");
    expect(lines[3]).toContain("embedding model cache:");
    expect(lines[4]).toContain("database:");
    expect(lines[5]).toContain("session-start hook:");
  });

  it("an advisory adds a line without displacing the other facts", () => {
    const lines = buildDoctorReport({
      ...BASE_FACTS,
      credential: { ...NO_CREDENTIAL, subscriptionExpired: true },
    });
    expect(lines).toHaveLength(7);
    expect(lines[0]).toContain("node:");
    expect(lines.at(-1)).toContain("session-start hook:");
  });

  it("node below floor is called out", () => {
    const lines = buildDoctorReport({ ...BASE_FACTS, nodeMajorVersion: 20, nodeMinVersion: 24 });
    expect(lines[0]).toContain("below floor");
  });

  it("gh not installed", () => {
    const lines = buildDoctorReport(BASE_FACTS);
    expect(lines[2]).toContain("not found");
  });

  it("gh installed, not authenticated", () => {
    const lines = buildDoctorReport({ ...BASE_FACTS, gh: { installed: true, authenticated: false } });
    expect(lines[2]).toContain("not authenticated");
  });

  it("gh installed and authenticated", () => {
    const lines = buildDoctorReport({ ...BASE_FACTS, gh: { installed: true, authenticated: true } });
    expect(lines[2]).toBe("gh: authenticated");
  });

  it("model cache present vs absent", () => {
    expect(buildDoctorReport({ ...BASE_FACTS, modelCachePresent: true })[3]).toContain("present");
    expect(buildDoctorReport({ ...BASE_FACTS, modelCachePresent: false })[3]).toContain("absent");
  });

  it.each([
    ["no-database", "database: no database yet"],
    ["ok", "database: ok"],
    ["corrupt", "database: integrity check failed"],
  ] as const)("db integrity %s", (status, expected) => {
    const line = buildDoctorReport({ ...BASE_FACTS, dbIntegrity: status })[4];
    expect(line).toBe(expected);
  });

  it("hook installed vs not", () => {
    expect(buildDoctorReport({ ...BASE_FACTS, hookInstalled: true })[5]).toBe("session-start hook: installed");
    expect(buildDoctorReport({ ...BASE_FACTS, hookInstalled: false })[5]).toBe("session-start hook: not installed");
  });
});
