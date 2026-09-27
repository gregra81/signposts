// The production `openRun` (src/cli/run-port.ts): everything one run command
// needs, opened for a single invocation and closed again by the caller.
//
// This is the composition root's other half. `buildProductionApp` cannot open
// these eagerly — `doctor` runs in a repo with no database, `init` must not
// create one before consent, and building an embedder loads an ONNX pipeline —
// so the root passes this function down and the command calls it once.
//
// One database handle, one checkpointer and one embedder per invocation. A
// command that built an embedder per session would pay that model load at
// every halt.

import type { OpenedRun, OpenRun, RunHandle } from "../cli/run-port.ts";
import { EMBEDDING_MODEL } from "../core/config/constants.ts";
import { buildExtractionGraph } from "../graph/index.ts";
import type { CommitOutcome } from "../graph/ports.ts";
import { makeCommitPort } from "./commit/commit-port.ts";
import { openCheckpointer } from "./db/checkpointer.ts";
import { openDb } from "./db/migrate.ts";
import { markBootstrapComplete } from "./db/repo-state.ts";
import { markProcessed, markSkipped, processedKeys } from "./db/sessions.ts";
import { createEmbedder } from "./embed/embedder.ts";
import type { Forge } from "./forge/forge.ts";
import { ghForge } from "./forge/gh-forge.ts";
import { resolveRepo } from "./git/remote-origin.ts";
import { authorEmail } from "./git/worktree.ts";
import { buildGraphPorts } from "./graph-ports.ts";
import { listPendingReviews } from "./review/pending.ts";
import { syncCorpus } from "./signpost/sync-corpus.ts";
import { discoverSessions } from "./transcript/discover.ts";

const NO_REPO =
  "could not determine repo (owner/name) from the 'origin' git remote — is this a git repo with a GitHub origin configured?";

const NO_AUTHOR = "git config user.email is not set — signposts records it as provenance";

/** `2026-09-06` — the ISO date `reinforce` records, without the time. */
function isoDate(now: Date): string {
  return now.toISOString().split("T")[0]!;
}

/**
 * `openRun`, over a given forge.
 *
 * The forge is the one port here that talks to something outside the machine,
 * so it is a parameter: an end-to-end test that drives a run through to
 * `commit` has no GitHub to open a pull request on, and stubbing `gh` on PATH
 * would be testing the shell rather than the run. Everything else — the
 * database, the checkpointer, the embedder, git itself — stays real, and R2
 * holds: this is still the only place any of them is constructed.
 */
export function makeOpenRun(forgeFor: (repoRoot: string) => Forge): OpenRun {
  return openRunWith.bind(null, forgeFor);
}

const openRunWith = async (
  forgeFor: (repoRoot: string) => Forge,
  { config, repoRoot, warn }: Parameters<OpenRun>[0],
): Promise<OpenedRun> => {
  const repo = resolveRepo(repoRoot);
  if (repo === null) {
    return { reason: NO_REPO };
  }
  const author = authorEmail(repoRoot);
  if (author === null) {
    return { reason: NO_AUTHOR };
  }

  // Where this invocation's proposals went: the branch, the pull request, the
  // reason there is none, and the command that would finish it by hand. The
  // commit port writes it; the run command prints it and derives its exit code
  // from it. Last write wins — a `run` is one session, and a `resume` that
  // reaches `commit` is one session too.
  let commitOutcome: CommitOutcome | null = null;

  const db = openDb(config.paths.dbPath);
  const { checkpointer, close: closeCheckpointer } = openCheckpointer(config.paths.checkpointPath);

  try {
    const ports = buildGraphPorts({
      db,
      embedder: await createEmbedder({
        modelCacheDir: config.paths.modelCacheDir,
        allowRemoteModels: config.retrieval.allow_remote_models,
        localModelPath: config.retrieval.local_model_path,
        embeddingModel: EMBEDDING_MODEL,
      }),
      repo,
      repoRoot,
      neighbourK: config.retrieval.k,
      author,
      now: () => new Date(),
      commit: makeCommitPort({
        repoRoot,
        worktreeDir: config.paths.worktreeDir,
        branchPattern: config.git.branch_pattern,
        author,
        // The checkout, not the worktree: the forge is asked which branch to
        // create the worktree on, before it exists (src/io/forge/gh-forge.ts).
        forge: forgeFor(repoRoot),
        warn,
        committed: (outcome) => {
          commitOutcome = outcome;
        },
        today: () => isoDate(new Date()),
      }),
    });

    const graph = buildExtractionGraph({ ports, checkpointer });

    const handle: RunHandle = {
      repo,
      graph,
      checkpointer,
      pendingIndex: ports.pendingIndex,
      index: ports.index,

      commitOutcome: () => commitOutcome,

      eligible: (now) =>
        discoverSessions({
          transcriptRoot: config.paths.transcriptRoot,
          repoRoot,
          processedKeys: processedKeys(db, repo),
          now,
          thresholds: {
            idleHours: config.thresholds.idle_hours,
            maxAgeDays: config.thresholds.max_age_days,
          },
          endedDir: config.paths.endedDir,
        }),

      pendingReviews: (now, options) => listPendingReviews({ graph, checkpointer, repo, now, warn, ...options }),

      syncCorpus: () =>
        syncCorpus({
          db,
          repo,
          knowledgeDir: config.paths.knowledgeDir,
          modelCacheDir: config.paths.modelCacheDir,
          retrieval: config.retrieval,
        }),

      finish: (session) => {
        // The first run in a repo gates everything to a person, whatever its
        // confidence, because the gate has never been checked by anyone
        // (06-review-and-pr.md, "The bootstrap run"). It stops being the first
        // run when a session of it finishes — without recording that, every
        // later run keeps sending auto-publishable additions to review.
        markBootstrapComplete(db, repo);
        markProcessed(db, {
          sessionId: session.sessionId,
          contentHash: session.contentHash,
          repo,
          repoRoot,
          lastActivityAt: session.lastActivityAt?.toISOString() ?? null,
          tokenEstimate: session.tokenEstimate,
        });
      },

      skip: (session) => {
        markSkipped(db, {
          sessionId: session.sessionId,
          contentHash: session.contentHash,
          repo,
          repoRoot,
          lastActivityAt: session.lastActivityAt?.toISOString() ?? null,
          tokenEstimate: null,
        }, session.reason);
      },

      close: () => {
        closeCheckpointer();
        db.close();
      },
    };
    return { handle };
  } catch (error) {
    // The handle is what closes these, and there is no handle yet.
    closeCheckpointer();
    db.close();
    throw error;
  }
};

export const openRun: OpenRun = makeOpenRun(ghForge);
