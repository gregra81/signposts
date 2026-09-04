// The tool contract `resolve_conflict` hands the model: three names, three
// argument schemas, three descriptions.
//
// The schemas are the reason this file exists. They are the first thing an
// untrusted tool call meets — before confine(), before any syscall — so a
// schema that shrugs at `{}` or at `startLine: -1` widens what
// src/io/tools/repo-tools.ts has to defend against.

import { describe, expect, it } from "vitest";
import {
  RESOLVE_TOOL_INPUT_SCHEMAS,
  RESOLVE_TOOL_NAMES,
  gitLogInputSchema,
  grepRepoInputSchema,
  readFileInputSchema,
  resolveToolDefs,
} from "../../../src/core/graph/resolve-tools.js";
import { RESOLVE_SYSTEM } from "../../../src/core/prompts/system.js";

describe("the tool definitions handed to the model", () => {
  it("is exactly the three read-only tools 12-wire-contracts.md names", () => {
    expect(resolveToolDefs().map((tool) => tool.name)).toEqual([
      "read_file",
      "git_log",
      "grep_repo",
    ]);
  });

  it("names every tool RESOLVE_SYSTEM promises the model", () => {
    // The prompt lists the three names in prose (14-prompts.md is verbatim,
    // so it cannot interpolate them). A tool renamed on one side only is a
    // prompt advertising a tool that does not exist.
    for (const name of Object.values(RESOLVE_TOOL_NAMES)) {
      expect(RESOLVE_SYSTEM).toContain(name);
    }
  });

  it("describes each tool as read-only and repository-confined", () => {
    for (const tool of resolveToolDefs()) {
      expect(tool.description).toContain("Read-only");
      expect(tool.description).toContain("repository");
    }
  });

  it("emits an object input schema with the documented properties", () => {
    const byName = Object.fromEntries(resolveToolDefs().map((tool) => [tool.name, tool]));

    expect(byName["read_file"]?.inputSchema).toMatchObject({
      type: "object",
      properties: { path: {}, startLine: {}, endLine: {} },
      required: ["path"],
    });
    expect(byName["git_log"]?.inputSchema).toMatchObject({
      type: "object",
      properties: { path: {}, limit: {} },
    });
    expect(byName["grep_repo"]?.inputSchema).toMatchObject({
      type: "object",
      properties: { pattern: {}, glob: {} },
      required: ["pattern"],
    });
  });

  it("strips the keywords the wire format rejects", () => {
    for (const tool of resolveToolDefs()) {
      expect(JSON.stringify(tool.inputSchema)).not.toContain("$schema");
      expect(JSON.stringify(tool.inputSchema)).not.toContain("minimum");
    }
  });

  it("exposes one schema per tool name", () => {
    expect(Object.keys(RESOLVE_TOOL_INPUT_SCHEMAS).sort()).toEqual(
      Object.values(RESOLVE_TOOL_NAMES).sort(),
    );
  });
});

describe("read_file arguments", () => {
  it("accepts a bare path", () => {
    expect(readFileInputSchema.safeParse({ path: "src/app.ts" }).success).toBe(true);
  });

  it("accepts a 1-based inclusive line range", () => {
    const parsed = readFileInputSchema.safeParse({ path: "a.ts", startLine: 1, endLine: 40 });
    expect(parsed.success).toBe(true);
  });

  it("rejects a missing path", () => {
    expect(readFileInputSchema.safeParse({}).success).toBe(false);
  });

  it("rejects a non-string path", () => {
    expect(readFileInputSchema.safeParse({ path: 7 }).success).toBe(false);
  });

  it("rejects a fractional line number", () => {
    expect(readFileInputSchema.safeParse({ path: "a.ts", startLine: 1.5 }).success).toBe(false);
  });

  it("rejects a line number below 1, because lines are 1-based", () => {
    expect(readFileInputSchema.safeParse({ path: "a.ts", startLine: 0 }).success).toBe(false);
    expect(readFileInputSchema.safeParse({ path: "a.ts", endLine: -3 }).success).toBe(false);
  });

  it("rejects an argument nobody declared", () => {
    expect(readFileInputSchema.safeParse({ path: "a.ts", encoding: "utf8" }).success).toBe(false);
  });
});

describe("git_log arguments", () => {
  it("accepts an empty object — path and limit are both optional", () => {
    expect(gitLogInputSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a path and a limit", () => {
    expect(gitLogInputSchema.safeParse({ path: "src", limit: 5 }).success).toBe(true);
  });

  it("rejects a limit below 1", () => {
    expect(gitLogInputSchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  it("rejects a fractional limit", () => {
    expect(gitLogInputSchema.safeParse({ limit: 2.5 }).success).toBe(false);
  });

  it("rejects an argument nobody declared", () => {
    expect(gitLogInputSchema.safeParse({ since: "yesterday" }).success).toBe(false);
  });
});

describe("grep_repo arguments", () => {
  it("accepts a bare pattern", () => {
    expect(grepRepoInputSchema.safeParse({ pattern: "read_only" }).success).toBe(true);
  });

  it("accepts a pattern and a glob", () => {
    expect(grepRepoInputSchema.safeParse({ pattern: "x", glob: "src" }).success).toBe(true);
  });

  it("rejects a missing pattern", () => {
    expect(grepRepoInputSchema.safeParse({ glob: "src" }).success).toBe(false);
  });

  it("rejects an empty pattern, which would match every line in the repo", () => {
    expect(grepRepoInputSchema.safeParse({ pattern: "" }).success).toBe(false);
  });

  it("rejects an argument nobody declared", () => {
    expect(grepRepoInputSchema.safeParse({ pattern: "x", ignoreCase: true }).success).toBe(false);
  });
});
