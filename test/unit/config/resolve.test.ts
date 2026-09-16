import { describe, expect, it, vi } from "vitest";
import { resolveConfig, type ResolveConfigInput } from "../../../src/core/config/resolve.js";
import {
  AUTO_PUBLISH_CONFIDENCE,
  BRANCH_PATTERN,
  NEIGHBOUR_K,
} from "../../../src/core/config/constants.js";

const REPO_ROOT = "/Users/greg/Projects/signposts";
const HOME_DIR = "/Users/greg";

function baseInput(overrides: Partial<ResolveConfigInput> = {}): ResolveConfigInput {
  return {
    repoRoot: REPO_ROOT,
    homeDir: HOME_DIR,
    env: {},
    ...overrides,
  };
}

describe("resolveConfig — precedence", () => {
  it("falls back to constants when no files and no env are given", () => {
    const config = resolveConfig(baseInput());
    expect(config.retrieval.k).toBe(NEIGHBOUR_K);
    expect(config.thresholds.auto_publish_confidence).toBe(AUTO_PUBLISH_CONFIDENCE);
  });

  it("a repo file overrides the constant default", () => {
    const config = resolveConfig(
      baseInput({ repoFileContents: "retrieval:\n  k: 9\n" }),
    );
    expect(config.retrieval.k).toBe(9);
  });

  it("a user file overrides the repo file", () => {
    const config = resolveConfig(
      baseInput({
        repoFileContents: "retrieval:\n  k: 9\n",
        userFileContents: "retrieval:\n  k: 11\n",
      }),
    );
    expect(config.retrieval.k).toBe(11);
  });

  it("env overrides the user file", () => {
    const config = resolveConfig(
      baseInput({
        repoFileContents: "retrieval:\n  k: 9\n",
        userFileContents: "retrieval:\n  k: 11\n",
        env: { SIGNPOSTS_RETRIEVAL_K: "13" },
      }),
    );
    expect(config.retrieval.k).toBe(13);
  });

  it("merges per-leaf: a repo file setting only retrieval.k leaves every other key at its constant", () => {
    const config = resolveConfig(
      baseInput({ repoFileContents: "retrieval:\n  k: 9\n" }),
    );
    expect(config.git.branch_pattern).toBe(BRANCH_PATTERN);
    expect(config.thresholds.auto_publish_confidence).toBe(AUTO_PUBLISH_CONFIDENCE);
  });

  it("layers compose across all four levels simultaneously, each at a different leaf", () => {
    const config = resolveConfig(
      baseInput({
        repoFileContents: "retrieval:\n  k: 9\n",
        userFileContents: "git:\n  branch_pattern: 'signposts/{author_slug}-user'\n",
        env: { SIGNPOSTS_THRESHOLDS_IDLE_HOURS: "48" },
      }),
    );
    expect(config.retrieval.k).toBe(9);
    expect(config.git.branch_pattern).toBe("signposts/{author_slug}-user");
    expect(config.thresholds.idle_hours).toBe(48);
  });
});

describe("resolveConfig — missing and malformed files", () => {
  it("treats missing repo and user files as absent, not an error", () => {
    expect(() => resolveConfig(baseInput())).not.toThrow();
  });

  it("treats an empty repo file as setting nothing, not an error", () => {
    const config = resolveConfig(baseInput({ repoFileContents: "" }));
    expect(config.retrieval.k).toBe(NEIGHBOUR_K);
  });

  it("treats a repo file that parses to null (e.g. just '~') as setting nothing", () => {
    const config = resolveConfig(baseInput({ repoFileContents: "~\n" }));
    expect(config.retrieval.k).toBe(NEIGHBOUR_K);
  });

  it("treats a section with every key commented out as setting nothing in that section", () => {
    const config = resolveConfig(
      baseInput({ repoFileContents: "retrieval:\n  # k: 6\n" }),
    );
    expect(config.retrieval.k).toBe(NEIGHBOUR_K);
  });

  it("rejects a non-numeric version via the env route as an env-coercion error, not a schema error", () => {
    // SIGNPOSTS_CONFIG_VERSION="abc" never reaches the schema at all — env.ts's
    // own number coercion rejects it first, with its own distinct message.
    expect(() => resolveConfig(baseInput({ env: { SIGNPOSTS_CONFIG_VERSION: "abc" } }))).toThrow(
      /SIGNPOSTS_CONFIG_VERSION.*not a valid number/,
    );
  });

  it("rejects a null-valued nested leaf (unaffected by the section normalisation)", () => {
    // Unlike a top-level scalar leaf, this null never enters the
    // normalisation loop at all — it's nested inside an already non-null
    // `git` object. Included to document that the scoping only ever
    // touches top-level values.
    expect(() =>
      resolveConfig(baseInput({ repoFileContents: "git:\n  auto_merge:\n" })),
    ).toThrow(/git\.auto_merge:/);
  });

  it("rejects a repo file whose top level is a YAML list, not a mapping", () => {
    expect(() =>
      resolveConfig(baseInput({ repoFileContents: "- one\n- two\n" })),
    ).toThrow(/Malformed YAML in repo config .*expected a top-level mapping/);
  });

  it("rejects a repo file whose top level is a bare scalar, not a mapping", () => {
    expect(() =>
      resolveConfig(baseInput({ repoFileContents: "just-a-string\n" })),
    ).toThrow(/Malformed YAML in repo config .*expected a top-level mapping/);
  });

  it("throws on malformed repo YAML, naming the repo file and carrying the parser's own reason", () => {
    // Asserting a real message here (not just the label prefix) matters:
    // a mutant that swallows the parse error and falls through to the
    // "not a top-level mapping" branch below produces a differently-
    // worded message with the same label prefix, so the label alone
    // wouldn't catch it. Matching "any non-empty reason, and not that
    // other branch's specific wording" proves the parser's own message
    // made it through, without coupling the suite to the `yaml` library's
    // exact phrasing the way asserting its literal text would.
    let error: unknown;
    try {
      resolveConfig(baseInput({ repoFileContents: "retrieval:\n  k: [1, 2\n" }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/^Malformed YAML in repo config \(\.signposts\/config\.yaml\): .+/);
    expect(message).not.toMatch(/expected a top-level mapping/);
  });

  it("throws on malformed user YAML, naming the user file and carrying the parser's own reason", () => {
    let error: unknown;
    try {
      resolveConfig(baseInput({ userFileContents: ":::not yaml:::\n  - [" }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/^Malformed YAML in user config \(~\/\.signposts\/config\.yaml\): .+/);
    expect(message).not.toMatch(/expected a top-level mapping/);
  });

  it("throws on a schema violation (wrong type), naming the offending path", () => {
    expect(() =>
      resolveConfig(baseInput({ repoFileContents: "retrieval:\n  k: not-a-number\n" })),
    ).toThrow(/retrieval\.k:/);
  });

  it("joins multiple schema violations on separate lines", () => {
    expect(() =>
      resolveConfig(
        baseInput({
          repoFileContents: "retrieval:\n  k: not-a-number\ngit:\n  branch_pattern: 1\n",
        }),
      ),
    ).toThrow(/retrieval\.k:.*\ngit\.branch_pattern:/s);
  });
});

describe("resolveConfig — git.auto_merge", () => {
  it("forces true to false and warns", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = resolveConfig(baseInput({ repoFileContents: "git:\n  auto_merge: true\n" }));
    expect(config.git.auto_merge).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/not configurable/i);
    warnSpy.mockRestore();
  });

  it("stays silent when auto_merge resolves to false", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveConfig(baseInput({ repoFileContents: "git:\n  auto_merge: false\n" }));
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("stays silent by default (no auto_merge set anywhere)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveConfig(baseInput());
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("resolveConfig — derived paths", () => {
  it("includes the derived state paths, keyed by the repo hash", () => {
    const config = resolveConfig(baseInput());
    expect(config.paths.stateDir).toContain(config.paths.repoHash);
    expect(config.paths.dbPath).toBe(`${config.paths.stateDir}/signposts.db`);
  });
});

describe("resolveConfig — frozen result", () => {
  it("throws when attempting to mutate the top level", () => {
    const config = resolveConfig(baseInput());
    expect(() => {
      // @ts-expect-error intentional mutation of a readonly field for the test
      config.version = 2;
    }).toThrow(TypeError);
  });
});
