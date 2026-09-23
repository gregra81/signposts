// `signpost publish`: push the developer's signposts branch and open or update
// its pull request.
//
// This used to be the tail of every run's commit, which meant a successful run
// ended with a PR on the developer's repository that nobody had asked for
// (19-value-to-a-user.md, open item 1). The run now stops at a local commit
// (./commit-port.ts) and this is the step the developer says yes to, after
// being shown what was proposed.
//
// What it publishes is whatever the worktree's branch has that the remote does
// not — one commit per session, across as many runs as the developer let
// accumulate. Each commit carries its session's PR section
// (`sessionCommitMessage`), so the body says the same thing it would have said
// had each run opened the PR itself, one section per session, appended.
//
// The order is deliberate. Push, then the PR — each step is worth keeping even
// if the next one fails. A pushed branch with no PR is one `gh pr create` away
// from being reviewed, so a forge failure returns the command to run by hand
// (06-review-and-pr.md: "never fail the run over PR creation").

import type { Forge, ForgeBranch } from "../forge/forge.ts";
import type { Publish, PublishOutcome } from "../../cli/run-port.ts";
import { branchPrefix } from "../../core/git/branch.ts";
import { PR_TITLE, prBody, prLabelsForSections, sectionFromCommit } from "../../core/pr/body.ts";
import { manualPrCommand, manualPushCommand } from "../../core/pr/manual-command.ts";
import { authorEmail, ensureWorktree, push, unpushedMessages, worktreeBranch } from "../git/worktree.ts";
import { REGENERATED_PATHS } from "./commit-port.ts";

/** `publish` over a given forge — a test passes a fake one, production `gh`. */
export function makePublish(forgeFor: (repoRoot: string) => Forge): Publish {
  return ({ config, repoRoot, warn }) =>
    publishBranch({
      repoRoot,
      worktreeDir: config.paths.worktreeDir,
      branchPattern: config.git.branch_pattern,
      forge: forgeFor(repoRoot),
      warn,
    });
}

export interface PublishBranchInput {
  repoRoot: string;
  /** Per-repo state directory's worktree — see WORKTREE_DIRNAME. */
  worktreeDir: string;
  /** config's `git.branch_pattern`. */
  branchPattern: string;
  forge: Forge;
  warn: (message: string) => void;
}

/** Pushes the worktree's branch and opens or updates its PR. Null when nothing is unpushed. */
export async function publishBranch(input: PublishBranchInput): Promise<PublishOutcome | null> {
  const { repoRoot, worktreeDir, forge, warn } = input;
  const branch = worktreeBranch(worktreeDir);
  if (branch === null) {
    return null;
  }

  // Catches up with the remote first, the same way a commit does: a branch
  // pushed from the developer's other machine since, or rebased onto after a
  // diverge, has to be what this push lands on top of.
  const worktree = ensureWorktree({ repoRoot, worktreeDir, branch, regenerated: REGENERATED_PATHS });
  if (!worktree.ok) {
    throw new Error(`could not prepare the worktree for ${branch}: ${worktree.output}`);
  }

  const messages = unpushedMessages(repoRoot, worktreeDir, branch);
  if (messages.length === 0) {
    return null;
  }
  // A commit made before sections rode in commit messages still gets a line,
  // for the reason `prSection` gives one to a session that proposed nothing.
  const sections = messages.map((message) => sectionFromCommit(message) ?? `${message.split("\n")[0]!}\n`);

  const openPr = await openPrFor(forge, input.branchPattern, authorEmail(repoRoot), branch, warn);
  const body = (existing: string) => prBody(existing, sections.join("\n"));

  const pushed = push(worktreeDir, branch);
  if (!pushed.ok) {
    // Nothing left the machine. The command covers both steps when the branch
    // has no pull request yet; when it has one, pushing puts the commits on
    // it, and sending anyone to `gh pr create` for a branch that has one is
    // an error, or a second PR on a fork.
    const command =
      openPr === null
        ? `${manualPushCommand(branch)} && ${manualPrCommand({ branch, title: PR_TITLE, body: body("") })}`
        : manualPushCommand(branch);
    warn(`signposts: could not push ${branch} (${pushed.output}). Run:\n${command}`);
    return {
      branch,
      sessions: sections.length,
      pr: openPr,
      url: null,
      reason: `could not push: ${pushed.output}`,
      manualCommand: command,
    };
  }

  return openOrUpdatePr({
    forge,
    branch,
    openPr,
    body,
    labels: prLabelsForSections(sections),
    sessions: sections.length,
    warn,
  });
}

/** The open pull request `branch` already has. A forge that cannot be asked is reported, not fatal. */
async function openPrFor(
  forge: Forge,
  branchPattern: string,
  author: string | null,
  branch: string,
  warn: (message: string) => void,
): Promise<number | null> {
  if (author === null) {
    return null;
  }
  const prefix = branchPrefix(branchPattern, author);
  let known: ForgeBranch[] = [];
  try {
    known = await forge.branchesUnder(prefix);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    warn(`signposts: could not ask the forge which ${prefix}* branches are under review (${reason}).`);
  }
  return known.find((candidate) => candidate.branch === branch && candidate.open)?.number ?? null;
}

interface PrInput {
  forge: Forge;
  branch: string;
  openPr: number | null;
  /** The body with this publish's sections appended to `existing`. */
  body: (existing: string) => string;
  labels: string[];
  sessions: number;
  warn: (message: string) => void;
}

/**
 * One open PR per developer: update the existing one's body, or open the first.
 *
 * A forge that cannot be reached is reported, not thrown. The branch is pushed
 * by this point, so the work is safe and one command away from review. What
 * that command is depends on how far this got: telling someone to open a pull
 * request that is already open sends them to `gh pr create` for a branch that
 * has one, which errors — or, on a fork, opens a second.
 */
async function openOrUpdatePr(input: PrInput): Promise<PublishOutcome> {
  const { forge, branch, sessions, warn } = input;
  // Assigned from `openPr` as well as from the listing, because the number is
  // what the failure path needs and a PR opened a line ago is no less open than
  // one found: a `setLabels` that throws right after a successful `openPr` used
  // to send the developer to `gh pr create` for the PR that call had just made.
  let open: number | null = input.openPr;
  // Only when this invocation opened it: `gh pr create` prints the URL, and a
  // pull request found by listing gives a number and nothing else.
  let url: string | null = null;

  try {
    if (open === null) {
      const created = await forge.openPr({ branch, title: PR_TITLE, body: input.body("") });
      open = created.number;
      url = created.url;
    } else {
      await forge.updatePr(open, input.body(await forge.readPrBody(open)));
    }
    await forge.setLabels(open, input.labels);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (open === null) {
      const command = manualPrCommand({ branch, title: PR_TITLE, body: input.body("") });
      warn(`signposts: pushed ${branch}, but could not open its pull request (${reason}). Run:\n${command}`);
      return {
        branch,
        sessions,
        pr: null,
        url: null,
        reason: `could not open a pull request: ${reason}`,
        manualCommand: command,
      };
    }
    warn(
      `signposts: pushed ${branch} and its commits are on pull request #${String(open)}, ` +
        `but that pull request could not be updated (${reason}). ` +
        `The body and labels are stale; the commits are not.`,
    );
    return {
      branch,
      sessions,
      pr: open,
      url,
      reason: `the pull request body and labels are stale: ${reason}`,
      // The commits are on the pull request; nothing is left to run by hand.
      manualCommand: null,
    };
  }

  return { branch, sessions, pr: open, url, reason: null, manualCommand: null };
}

/**
 * How many sessions are committed on the worktree's branch and not pushed —
 * one commit per session. Zero when there is no worktree. What `settle` and
 * `publish` write into the status file for the status line
 * (19-value-to-a-user.md, open item 14).
 */
export function countUnpublished(repoRoot: string, worktreeDir: string): number {
  const branch = worktreeBranch(worktreeDir);
  return branch === null ? 0 : unpushedMessages(repoRoot, worktreeDir, branch).length;
}
