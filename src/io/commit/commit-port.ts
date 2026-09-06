// Node 10's port: write the markdown, regenerate the index, commit, push,
// open or update the pull request.
//
// Everything happens in the worktree (src/io/git/worktree.ts), never in the
// developer's checkout. The corpus this applies to is therefore the branch's,
// not the working tree's: successive sessions accumulate on one branch, and a
// proposal is invisible in the developer's editor until the PR merges.
//
// The order is deliberate. Files, then commit, then push, then the PR — each
// step is worth keeping even if the next one fails. A pushed branch with no
// PR is one `gh pr create` away from being reviewed; a lost extraction is
// gone. So a forge failure returns the command to run by hand
// (06-review-and-pr.md: "never fail the run over PR creation").
//
// The local embedding index is deliberately not rebuilt here. What this
// writes is *proposed*, and proposals reach retrieval through the pending
// index (src/io/db/pending-index.ts), which the run commands maintain. The
// merged corpus has not changed, so the index that mirrors it has not either
// — it rebuilds on the next run, when the content hash moves.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ZodError } from "zod";
import type { Forge } from "../../app.ts";
import type { CommitInput, CommitPort } from "../../graph/ports.ts";
import { formatZodError } from "../../core/errors/format-zod-error.ts";
import { INDEX_FILENAME, SIGNPOSTS_DIRNAME } from "../../core/config/constants.ts";
import { branchFor } from "../../core/git/branch.ts";
import { commitMessage, prBody, prLabels, prSection, PR_TITLE } from "../../core/pr/body.ts";
import { applyOperations, signpostPath } from "../../core/signpost/apply-operations.ts";
import { parseSignpost, serialiseSignpost } from "../../core/signpost/codec.ts";
import { generateIndexDoc } from "../../core/signpost/index-doc.ts";
import type { Signpost } from "../../core/signpost/schema.ts";
import { readSignpostFiles } from "../signpost/read-dir.ts";
import { commitAll, ensureWorktree, push } from "../git/worktree.ts";

export interface CommitPortInput {
  repoRoot: string;
  /** Per-repo state directory's worktree — see WORKTREE_DIRNAME. */
  worktreeDir: string;
  /** config's `git.branch_pattern`. */
  branchPattern: string;
  /** REAL `git config user.email`, resolved once at the composition root. */
  author: string;
  forge: Forge;
  /** Where a step that could not finish says so. */
  warn: (message: string) => void;
  /** ISO date, from the injected clock — `reinforce` records it. */
  today: () => string;
}

export function makeCommitPort(input: CommitPortInput): CommitPort {
  const branch = branchFor(input.branchPattern, input.author);

  return {
    async apply(operations: CommitInput): Promise<void> {
      if (operations.operations.length === 0) {
        // A session where the gate approved nothing and the reviewer accepted
        // nothing. Nothing to write, and an empty commit would put a line in
        // the PR history that describes no change.
        return;
      }

      const worktree = ensureWorktree({
        repoRoot: operations.repoRoot,
        worktreeDir: input.worktreeDir,
        branch,
      });
      if (!worktree.ok) {
        throw new Error(`signposts: could not prepare the worktree for ${branch}: ${worktree.output}`);
      }

      const knowledgeDir = path.join(input.worktreeDir, SIGNPOSTS_DIRNAME);
      const applied = applyOperations({
        corpus: readCorpus(knowledgeDir),
        operations: operations.operations,
        now: input.today(),
      });

      const written = writeCorpus(knowledgeDir, applied.corpus, applied.changed);
      const committed = commitAll({
        worktreeDir: input.worktreeDir,
        paths: written,
        message: commitMessage(operations.sessionId, operations.operations),
      });
      if (!committed.ok) {
        throw new Error(`signposts: could not commit to ${branch}: ${committed.output}`);
      }

      const pushed = push(input.worktreeDir, branch);
      if (!pushed.ok) {
        input.warn(
          `signposts: wrote ${String(written.length)} file(s) to ${branch} but could not push: ${pushed.output}`,
        );
        return;
      }

      await openOrUpdatePr(input, branch, operations);
    },
  };
}

/** Every signpost currently on the branch. A file that no longer parses stops the run. */
function readCorpus(knowledgeDir: string): Signpost[] {
  return readSignpostFiles(knowledgeDir).map((file) => {
    try {
      return parseSignpost(file.content);
    } catch (error) {
      const detail = error instanceof ZodError ? formatZodError(error) : String(error);
      // Unlike `signpost index`, which skips a bad file and carries on, this
      // refuses: the corpus is about to be edited, and applying operations
      // against a corpus missing one of its members can write a duplicate id
      // or reinforce something it cannot see.
      throw new Error(`signposts: ${file.path} on the signposts branch does not parse: ${detail}`);
    }
  });
}

/** Writes the changed signposts and the regenerated index. Returns paths relative to the worktree. */
function writeCorpus(
  knowledgeDir: string,
  corpus: readonly Signpost[],
  changed: readonly string[],
): string[] {
  const byId = new Map(corpus.map((signpost) => [signpost.id, signpost]));
  const written: string[] = [];

  for (const id of changed) {
    const signpost = byId.get(id)!;
    const relative = path.join(SIGNPOSTS_DIRNAME, signpostPath(signpost));
    const absolute = path.join(path.dirname(knowledgeDir), relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, serialiseSignpost(signpost), "utf8");
    written.push(relative);
  }

  const indexRelative = path.join(SIGNPOSTS_DIRNAME, INDEX_FILENAME);
  mkdirSync(knowledgeDir, { recursive: true });
  writeFileSync(path.join(knowledgeDir, INDEX_FILENAME), generateIndexDoc(corpus), "utf8");
  written.push(indexRelative);

  return written;
}

/**
 * One open PR per developer: commit onto the existing one and update its
 * body, or open the first.
 *
 * A forge that cannot be reached is reported, not thrown. The branch is
 * pushed by this point, so the work is safe and one command away from review.
 * What that command is depends on how far this got: telling someone to open a
 * pull request that is already open sends them to `gh pr create` for a branch
 * that has one, which errors — or, on a fork, opens a second.
 */
async function openOrUpdatePr(
  input: CommitPortInput,
  branch: string,
  operations: CommitInput,
): Promise<void> {
  const section = prSection(operations.sessionId, operations.operations);
  let open: number | null = null;

  try {
    open = await input.forge.hasOpenPr(branch);
    const prNumber =
      open ?? (await input.forge.openPr({ branch, title: PR_TITLE, body: prBody("", section) }));

    if (open !== null) {
      await input.forge.updatePr(prNumber, prBody(await input.forge.readPrBody(prNumber), section));
    }

    await input.forge.setLabels(prNumber, prLabels(operations.operations));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    input.warn(
      open === null
        ? `signposts: pushed ${branch}, but could not open its pull request (${reason}). ` +
            `Run: gh pr create --head ${branch} --title ${JSON.stringify(PR_TITLE)}`
        : `signposts: pushed ${branch} and its commit is on pull request #${String(open)}, ` +
            `but that pull request could not be updated (${reason}). ` +
            `The body and labels are stale; the commit is not.`,
    );
  }
}
