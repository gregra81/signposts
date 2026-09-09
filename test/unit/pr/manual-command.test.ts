// The quoting of the `gh pr create` command a developer runs by hand. The
// behaviour test in test/behaviour/commit/commit-port.test.ts runs the real
// thing through a real shell; these are the characters that make that
// necessary, stated one at a time.

import { describe, expect, it } from "vitest";
import { manualPrCommand } from "../../../src/core/pr/manual-command.js";

const BRANCH = "signposts/greg/2026-09-05";

function command(overrides: { title?: string; body?: string } = {}): string {
  return manualPrCommand({
    branch: BRANCH,
    title: overrides.title ?? "signposts: knowledge proposed for review",
    body: overrides.body ?? "## Proposed\n\n| add | staging-read-only |\n",
  });
}

describe("the manual pull request command", () => {
  it("leaves a plain branch name unquoted, so the line reads like something typed", () => {
    expect(command()).toContain(`gh pr create --head ${BRANCH} --title `);
  });

  it("quotes a title whose colon and spaces a shell would otherwise split", () => {
    expect(command()).toContain("--title 'signposts: knowledge proposed for review'");
  });

  it("keeps a multi-line body inside one argument", () => {
    // A body cut off at the first newline is a pull request with a heading
    // and no table.
    expect(command()).toContain("--body '## Proposed\n\n| add | staging-read-only |\n'");
  });

  it("survives an apostrophe in an evidence line", () => {
    // There is no escape character inside POSIX single quotes: the quote has
    // to be closed, escaped and reopened.
    expect(command({ body: "the ETL job's window" })).toContain(
      `--body 'the ETL job'\\''s window'`,
    );
  });

  it("quotes what a shell would otherwise expand", () => {
    const line = command({ body: "$(rm -rf /) `whoami` ${HOME}" });
    expect(line).toContain("--body '$(rm -rf /) `whoami` ${HOME}'");
  });
});
