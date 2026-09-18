// readConventions: the repo's CLAUDE.md as the critic sees it.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONVENTIONS_FILENAME, CRITIC_CONVENTIONS_MAX_CHARS } from "../../../../src/core/config/constants.js";
import { readConventions } from "../../../../src/io/repo/conventions.js";

describe("readConventions", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(path.join(tmpdir(), "signposts-conventions-"));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function writeConventions(text: string): void {
    writeFileSync(path.join(repoRoot, CONVENTIONS_FILENAME), text, "utf8");
  }

  it("reads the repo's conventions file", () => {
    writeConventions("Business logic lives in core/.");

    expect(readConventions(repoRoot)).toBe("Business logic lives in core/.");
  });

  it("caps what it returns, because this rides on every critic call", () => {
    writeConventions("x".repeat(CRITIC_CONVENTIONS_MAX_CHARS + 500));

    expect(readConventions(repoRoot)).toHaveLength(CRITIC_CONVENTIONS_MAX_CHARS);
  });

  it("is null for a repo with no conventions file, which is most of them", () => {
    expect(readConventions(repoRoot)).toBeNull();
  });

  it("is null for an empty one, rather than an empty section in the prompt", () => {
    writeConventions("");

    expect(readConventions(repoRoot)).toBeNull();
  });
});
