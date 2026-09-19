// The production GraphPorts, built in one place and handed to the graph.
//
// Everything here is the real thing: the transcript reducer over the file on
// disk, retrieval over the local SQLite mirror, the pending index between
// sessions, and the commit port that writes a branch and opens the PR. The
// model port is the exception only in that there is nothing to build — the
// session answers, so it is `hostModel` (src/graph/host-model.ts).
//
// Constructed by the composition root (./production-app.ts) and nowhere else
// (R2). The database handle and the embedder are passed in rather than opened
// here: both are per-run resources with a lifetime the caller owns, and the
// embedder in particular loads an ONNX pipeline every time it is created, so
// a run builds exactly one.

import type Database from "better-sqlite3";
import type { GraphPorts } from "../graph/ports.ts";
import { hostModel } from "../graph/host-model.ts";
import { normalize } from "../core/retrieval/normalize.ts";
import type { Candidate, NeighbourSignpost } from "../core/contracts/graph.ts";
import type { PendingProposal } from "../core/graph/pending.ts";
import type { Embedder } from "./embed/embedder.ts";
import { findNeighbours } from "./db/neighbours.ts";
import { clearPending, indexPending } from "./db/pending-index.ts";
import { hasCompletedBootstrap } from "./db/repo-state.ts";
import { signpostById, signpostIds, signpostsByIds } from "./db/signposts.ts";
import { gutterSession } from "./gutter/session.ts";
import { readConventions } from "./repo/conventions.ts";
import type { CommitPort } from "../graph/ports.ts";

export interface GraphPortsInput {
  db: Database.Database;
  embedder: Embedder;
  repo: string;
  repoRoot: string;
  /** config's `retrieval.k`. */
  neighbourK: number;
  /** REAL `git config user.email` — written into provenance, never a pseudonym. */
  author: string;
  commit: CommitPort;
  now: () => Date;
}

export function buildGraphPorts(input: GraphPortsInput): GraphPorts {
  const { db, embedder, repo, repoRoot } = input;

  return {
    model: hostModel,

    gutter: {
      gutter: (transcriptPath: string) => gutterSession(transcriptPath, { repo, repoRoot }),
    },

    conventions: {
      // Read per call rather than once per run: a run outlives several model
      // calls and the file is small. Capped here, so nothing downstream has to
      // know how long it may be.
      async read(): Promise<string | null> {
        return readConventions(repoRoot);
      },
    },

    neighbours: {
      async find(forRepo: string, candidate: Candidate): Promise<NeighbourSignpost[]> {
        // Normalised before embedding, the same way the index was built —
        // an unnormalised query embeds into a different neighbourhood than
        // the rows it is being compared against (05-retrieval.md).
        const [embedding] = await embedder.embed([normalize(candidate.claim)]);
        if (embedding === undefined) {
          return [];
        }
        const ranked = findNeighbours(
          db,
          forRepo,
          {
            claim: normalize(candidate.claim),
            embedding,
            ...(candidate.scope.paths === undefined ? {} : { paths: candidate.scope.paths }),
          },
          input.neighbourK,
        );

        // Ranking returns the four fields retrieval needs; `classify` and the
        // resolver are shown the whole signpost, so the ranked ids are
        // hydrated from the same mirror in one query, in rank order.
        const byId = new Map(
          signpostsByIds(
            db,
            forRepo,
            ranked.map((neighbour) => neighbour.id),
          ).map((signpost) => [signpost.id, signpost]),
        );
        return ranked.flatMap((neighbour) => {
          const signpost = byId.get(neighbour.id);
          return signpost === undefined
            ? []
            : [{ ...signpost, ...(neighbour.pending === undefined ? {} : { pending: neighbour.pending }) }];
        });
      },
    },

    pendingIndex: {
      indexPending: (forRepo: string, proposals: readonly PendingProposal[]) =>
        indexPending(db, { embedder, repo: forRepo, proposals }),
      clear: async (forRepo: string) => {
        clearPending(db, forRepo);
      },
    },

    index: {
      existingIds: async (forRepo: string) => signpostIds(db, forRepo),
      isBootstrap: async (forRepo: string) => !hasCompletedBootstrap(db, forRepo),
      byId: async (forRepo: string, id: string) => signpostById(db, forRepo, id),
    },

    commit: input.commit,
    author: input.author,
    now: input.now,
  };
}
