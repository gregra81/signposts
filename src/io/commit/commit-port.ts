// Node 10's port: write the markdown, regenerate the index, commit. It stops
// there.
//
// Everything happens in the worktree (src/io/git/worktree.ts), never in the
// developer's checkout. The corpus this applies to is therefore the branch's,
// not the working tree's: successive sessions accumulate on one branch, and a
// proposal is invisible in the developer's editor until the PR merges.
//
// It does not push and does not touch the pull request. It used to do both,
// and the first thing a developer saw after a successful run was a PR on their
// repository with nobody in the loop — correct by the gate, and still a
// surprise (19-value-to-a-user.md, open item 1). The run ends with the work
// committed locally; the developer is shown what was proposed and
// `signpost publish` (./publish.ts) pushes it and opens or updates the PR.
// Each commit carries its session's PR section, which is how `publish` knows
// what to say once the operations are long gone.
//
// The local embedding index is deliberately not rebuilt here. What this
// writes is *proposed*, and proposals reach retrieval through the pending
// index (src/io/db/pending-index.ts), which the run commands maintain. The
// merged corpus has not changed, so the index that mirrors it has not either
// — it rebuilds on the next run, when the content hash moves.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Forge, ForgeBranch } from "../forge/forge.ts";
import type { CommitInput, CommitOutcome, CommitPort } from "../../graph/ports.ts";
import { describeError } from "../../core/errors/format-zod-error.ts";
import { INDEX_FILENAME, SIGNPOSTS_DIRNAME } from "../../core/config/constants.ts";
import { branchPrefix, pickBranch } from "../../core/git/branch.ts";
import { sessionCommitMessage } from "../../core/pr/body.ts";
import { applyOperations, signpostPath } from "../../core/signpost/apply-operations.ts";
import { parseSignpost, serialiseSignpost } from "../../core/signpost/codec.ts";
import { generateIndexDoc } from "../../core/signpost/index-doc.ts";
import type { Signpost } from "../../core/signpost/schema.ts";
import { readSignpostFiles } from "../signpost/read-dir.ts";
import { commitAll, ensureWorktree, unpushedMessages, worktreeBranch } from "../git/worktree.ts";

export interface CommitPortInput {
  repoRoot: string;
  /** Per-repo state directory's worktree — see WORKTREE_DIRNAME. */
  worktreeDir: string;
  /** config's `git.branch_pattern`. */
  branchPattern: string;
  /** REAL `git config user.email`, resolved once at the composition root. */
  author: string;
  /** Asked which branch is under review. Nothing is opened or updated on it here. */
  forge: Forge;
  /** Where a step that could not finish says so. */
  warn: (message: string) => void;
  /**
   * Called once per session that committed anything, with the branch it went
   * to and the pull request `publish` will add it to. The run command prints
   * it as RunOutput's `commit`.
   */
  committed: (outcome: CommitOutcome) => void;
  /** ISO date, from the injected clock — `reinforce` records it. */
  today: () => string;
}

/** The index is rewritten from the whole corpus on every commit — see `ensureWorktree`. */
export const REGENERATED_PATHS: readonly string[] = [path.join(SIGNPOSTS_DIRNAME, INDEX_FILENAME)];

export function makeCommitPort(input: CommitPortInput): CommitPort {
  return {
    async apply(operations: CommitInput): Promise<void> {
      if (operations.operations.length === 0) {
        // A session where the gate approved nothing and the reviewer accepted
        // nothing. Nothing to write, and an empty commit would put a line in
        // the PR history that describes no change.
        return;
      }

      // Per session, not once when the port is built: a run processes several
      // sessions, and the first of them can be what starts the branch the
      // second should commit onto.
      const cycle = await chooseBranch(input);
      const branch = cycle.branch;

      const worktree = ensureWorktree({
        repoRoot: operations.repoRoot,
        worktreeDir: input.worktreeDir,
        branch,
        // `writeCorpus` rewrites the index from the whole corpus every time,
        // so two commits both "changing" it is an artefact of that rather
        // than a disagreement, and it is rewritten again a few lines below.
        regenerated: REGENERATED_PATHS,
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

      // Reported, not thrown: an operation that could not be applied is one
      // proposal, and losing the whole session over it costs every model call
      // the developer answered by hand. The branch carries the rest.
      for (const skip of applied.skipped) {
        input.warn(
          `signposts: skipped ${skip.op} ${skip.id} on ${branch} — ${skip.reason}. ` +
            "Re-run `signpost index` if the base branch has moved.",
        );
      }

      const written = writeCorpus(knowledgeDir, applied.corpus, applied.changed);
      const committed = commitAll({
        worktreeDir: input.worktreeDir,
        paths: written,
        message: sessionCommitMessage(operations.sessionId, operations.operations),
      });
      if (!committed.ok) {
        throw new Error(`signposts: could not commit to ${branch}: ${committed.output}`);
      }

      input.committed({ branch, pr: cycle.openPr });
    },
  };
}

/** The branch this session commits on, and the pull request it already has. */
interface Cycle {
  branch: string;
  /** The open PR on that branch, when the listing already found one. */
  openPr: number | null;
}

/**
 * Which cycle this session belongs to: the branch under review, the one the
 * developer has not published yet, or a new one.
 *
 * A forge that cannot be reached is not fatal here either. With no listing
 * there is nothing to say a branch is under review, so today's name is minted
 * — which is the branch an earlier session today already committed to, and a
 * new one otherwise. `publish` asks the forge again when it pushes.
 */
async function chooseBranch(input: CommitPortInput): Promise<Cycle> {
  const prefix = branchPrefix(input.branchPattern, input.author);

  let known: ForgeBranch[] = [];
  try {
    known = await input.forge.branchesUnder(prefix);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    input.warn(`signposts: could not ask the forge which ${prefix}* branches are under review (${reason}).`);
  }

  const current = worktreeBranch(input.worktreeDir);
  const unpublished =
    current !== null && unpushedMessages(input.repoRoot, input.worktreeDir, current).length > 0
      ? current
      : null;
  const branch = pickBranch({
    pattern: input.branchPattern,
    email: input.author,
    date: input.today(),
    known,
    unpublished,
  });

  return {
    branch,
    openPr: known.find((candidate) => candidate.branch === branch && candidate.open)?.number ?? null,
  };
}

/** Every signpost currently on the branch. A file that no longer parses stops the run. */
function readCorpus(knowledgeDir: string): Signpost[] {
  return readSignpostFiles(knowledgeDir).map((file) => {
    try {
      return parseSignpost(file.content);
    } catch (error) {
      const detail = describeError(error);
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
