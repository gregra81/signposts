// The Forge port over the `gh` CLI (06-review-and-pr.md, "Auth"): most
// developers already have it authenticated, and it carries the GitHub host,
// the token and the enterprise configuration signposts would otherwise have
// to learn about.
//
// Every call reports its failure rather than throwing a subprocess error at
// the graph: by the time anything here runs, the run has already done the
// expensive part, and a missing `gh` must not lose it. The caller
// (src/io/commit/commit-port.ts) turns a failure into "the branch is pushed,
// here is the command to open the PR yourself".

import { spawnSync } from "node:child_process";
import type { Forge } from "./forge.ts";

const OPEN_STATE = "open";

export class GhCliError extends Error {}

function gh(cwd: string, args: readonly string[]): string {
  const result = spawnSync("gh", args, { cwd, encoding: "utf8" });
  if (result.error !== undefined) {
    throw new GhCliError(`gh could not be run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new GhCliError(`gh ${args[0] ?? ""} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

interface PrView {
  number: number;
  state: string;
  body: string;
}

/**
 * `gh` runs against the repository it is invoked in, so the forge is bound to
 * a working directory — the worktree, whose `origin` is the same remote the
 * developer's checkout has.
 */
export function ghForge(cwd: string): Forge {
  const view = (prNumber: number): PrView =>
    JSON.parse(gh(cwd, ["pr", "view", String(prNumber), "--json", "number,state,body"])) as PrView;

  return {
    async hasOpenPr(branch: string): Promise<number | null> {
      const listed = JSON.parse(
        gh(cwd, ["pr", "list", "--head", branch, "--state", OPEN_STATE, "--json", "number", "--limit", "1"]),
      ) as { number: number }[];
      return listed[0]?.number ?? null;
    },

    async openPr(input: { branch: string; title: string; body: string }): Promise<number> {
      const url = gh(cwd, [
        "pr",
        "create",
        "--head",
        input.branch,
        "--title",
        input.title,
        "--body",
        input.body,
      ]).trim();
      // `gh pr create` prints the URL, and the number is its last segment.
      // `Number("")` is 0, and an integer — so the emptiness of a `gh` that
      // exited 0 without printing a URL has to be caught by the range, not by
      // the integer check.
      const number = Number(url.split("/").at(-1));
      if (!Number.isInteger(number) || number <= 0) {
        throw new GhCliError(`gh pr create did not return a pull request URL: ${url}`);
      }
      return number;
    },

    async readPrBody(prNumber: number): Promise<string> {
      return view(prNumber).body;
    },

    async updatePr(prNumber: number, body: string): Promise<void> {
      gh(cwd, ["pr", "edit", String(prNumber), "--body", body]);
    },

    async setLabels(prNumber: number, labels: readonly string[]): Promise<void> {
      if (labels.length === 0) {
        return;
      }
      gh(cwd, ["pr", "edit", String(prNumber), ...labels.flatMap((label) => ["--add-label", label])]);
    },
  };
}
