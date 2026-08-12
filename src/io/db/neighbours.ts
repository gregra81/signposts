// IO-level neighbour retrieval for the write-path duplicate/contradiction
// check: wires the pure core (RRF fusion, path-overlap boost) to the real
// signpost_vec / signpost_fts tables. See 05-retrieval.md "Hybrid search" /
// "Filter before you search" and 16-build-plan.md's core/io split —
// everything decision-shaped lives in src/core/retrieval/, this file is
// glue plus the actual queries.
//
// Hard filters (repo, status='active') are applied inside the queries
// themselves — never a similarity floor. If the fused, filtered result is
// empty or short of k, that is returned as-is; nothing pads it out.

import type Database from "better-sqlite3";
import { combineScore } from "../../core/retrieval/combine-score.js";
import { ftsQuery } from "../../core/retrieval/fts-query.js";
import { pathOverlapBoost } from "../../core/retrieval/path-overlap.js";
import { fuseRrf } from "../../core/retrieval/rrf.js";
import { vectorToBlob } from "../../core/retrieval/vector-codec.js";
import { scopeSchema, statusSchema, type Scope } from "../../core/signpost/schema.js";

// Single source of truth for the "active" literal: the schema's own enum,
// not a second hand-maintained string.
const ACTIVE_STATUS = statusSchema.enum.active;

export interface NeighbourCandidate {
  /** Already-normalised, already-embedded claim text — see normalize.ts / the embedder. */
  claim: string;
  embedding: readonly number[];
  /** Candidate's scope.paths, if any — fed to the path-overlap boost (R2). */
  paths?: readonly string[];
}

export interface Neighbour {
  id: string;
  claim: string;
  evidence: string;
  scope: Scope;
}

interface SignpostIdRow {
  signpost_id: string;
}

interface SignpostRow {
  id: string;
  claim: string;
  evidence: string;
  scope_json: string;
}

/**
 * Retrieves up to `k` active neighbours for `candidate` in `repo`, fusing a
 * vector-KNN ranking and an FTS ranking via RRF, then additively combining
 * each fused score with its path-overlap boost (see combineScore) before
 * sorting. No minimum similarity floor: an empty or short result is
 * returned as-is.
 */
export function findNeighbours(
  db: Database.Database,
  repo: string,
  candidate: NeighbourCandidate,
  k: number,
): Neighbour[] {
  const vectorRows = db
    .prepare(
      `SELECT signpost_id
       FROM signpost_vec
       WHERE repo = ? AND claim_embedding MATCH ? AND k = ?
         AND signpost_id IN (SELECT id FROM signposts WHERE repo = ? AND status = ?)
       ORDER BY distance`,
    )
    .all(repo, vectorToBlob(candidate.embedding), k, repo, ACTIVE_STATUS) as SignpostIdRow[];

  const query = ftsQuery(candidate.claim);
  const ftsRows =
    query === null
      ? []
      : (db
          .prepare(
            `SELECT signpost_id
             FROM signpost_fts
             WHERE repo = ? AND signpost_fts MATCH ?
               AND signpost_id IN (SELECT id FROM signposts WHERE repo = ? AND status = ?)
             ORDER BY bm25(signpost_fts)
             LIMIT ?`,
          )
          .all(repo, query, repo, ACTIVE_STATUS, k) as SignpostIdRow[]);

  const fused = fuseRrf(
    vectorRows.map((row) => row.signpost_id),
    ftsRows.map((row) => row.signpost_id),
  );
  if (fused.length === 0) {
    return [];
  }

  const ids = fused.map((entry) => entry.id);
  const placeholders = ids.map(() => "?").join(", ");
  const signpostRows = db
    .prepare(`SELECT id, claim, evidence, scope_json FROM signposts WHERE repo = ? AND id IN (${placeholders})`)
    .all(repo, ...ids) as SignpostRow[];
  const rowsById = new Map(signpostRows.map((row) => [row.id, row]));

  return fused
    .map((entry) => {
      const row = rowsById.get(entry.id);
      if (!row) {
        return null;
      }
      const scope = scopeSchema.parse(JSON.parse(row.scope_json));
      const boost = pathOverlapBoost(candidate.paths, scope.paths);
      const combined = combineScore(entry.score, boost);
      return { neighbour: { id: row.id, claim: row.claim, evidence: row.evidence, scope }, combined };
    })
    .filter((entry): entry is { neighbour: Neighbour; combined: number } => entry !== null)
    .sort((a, b) => b.combined - a.combined)
    .slice(0, k)
    .map((entry) => entry.neighbour);
}
