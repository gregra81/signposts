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
import { combineScore } from "../../core/retrieval/combine-score.ts";
import { ftsQuery } from "../../core/retrieval/fts-query.ts";
import { pathOverlapBoost } from "../../core/retrieval/path-overlap.ts";
import { fuseRrf } from "../../core/retrieval/rrf.ts";
import { vectorToBlob } from "../../core/retrieval/vector-codec.ts";
import { PENDING_STATES, type PendingState } from "../../core/contracts/graph.ts";
import { ACTIVE_STATUS, scopeSchema, type Scope } from "../../core/signpost/schema.ts";

// Shared by both queries below — the "hard filter" half of the "Hard
// filters (repo, status='active')" contract, kept in one place so the two
// prepared statements can't drift apart.
const ACTIVE_IN_REPO_FILTER = "signpost_id IN (SELECT id FROM signposts WHERE repo = ? AND status = ?)";

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
  /**
   * Present when this neighbour was proposed by an earlier session in this run
   * and is not merged (./pending-index.ts): `awaiting_review` when a person is
   * still holding it, `in_pr` when it cleared the gate and is already in the
   * branch. Retrieved like any other neighbour — pending is a review state,
   * not a lifecycle state — but carried out of here because both `classify`
   * and the gate act on it (06-review-and-pr.md).
   *
   * Absent, not `null`, for a merged neighbour, which is the contract
   * ../../core/contracts/graph.ts's neighbourSignpostSchema states and the
   * reason for it: the classify user turn for an ordinary corpus has to stay
   * byte-for-byte what it was, because a recorded fixture keys on those bytes
   * (../../core/prompts/user-turns.ts).
   */
  pending?: PendingState;
}

interface SignpostIdRow {
  signpost_id: string;
}

/**
 * Exported for the read path (./search-signposts.ts), which projects the same
 * row into 12-wire-contracts.md's MCP shape. `category` and `confidence` are
 * selected for that consumer alone: a neighbour is judged on its claim, and
 * neither field reaches the classify prompt.
 */
export interface SignpostRow {
  id: string;
  claim: string;
  evidence: string;
  category: string;
  confidence: number;
  scope_json: string;
  is_pending: number;
  pending_review: number;
}

/** A row, its parsed scope, and the score it was ranked on — see rankSignposts. */
export interface RankedRow {
  row: SignpostRow;
  /** Parsed once here, because the ranking needs it for the path-overlap boost. */
  scope: Scope;
  score: number;
}

/** Which of the two pending states a proposed row is in — see Neighbour.pending. */
function pendingStateOf(row: SignpostRow): PendingState {
  return row.pending_review === 1 ? PENDING_STATES.awaiting_review : PENDING_STATES.in_pr;
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
  return rankSignposts(db, repo, candidate, k).map(({ row, scope }) => ({
    id: row.id,
    claim: row.claim,
    evidence: row.evidence,
    scope,
    ...(row.is_pending === 1 ? { pending: pendingStateOf(row) } : {}),
  }));
}

/**
 * The retrieval itself, shared with the read path (./search-signposts.ts):
 * the two vary only in what they project out of the row, and a second copy of
 * the two queries is a second place for the hard filter to drift.
 *
 * Returns at most `k` rows, highest combined score first.
 */
export function rankSignposts(
  db: Database.Database,
  repo: string,
  candidate: NeighbourCandidate,
  k: number,
): RankedRow[] {
  if (k <= 0) {
    return [];
  }

  const vectorRows = db
    .prepare(
      `SELECT signpost_id
       FROM signpost_vec
       WHERE repo = ? AND claim_embedding MATCH ? AND k = ?
         AND ${ACTIVE_IN_REPO_FILTER}
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
               AND ${ACTIVE_IN_REPO_FILTER}
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
    .prepare(
      `SELECT id, claim, evidence, category, confidence, scope_json, is_pending, pending_review FROM signposts WHERE repo = ? AND id IN (${placeholders})`,
    )
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
      return { row, scope, score: combineScore(entry.score, boost) };
    })
    .filter((entry): entry is RankedRow => entry !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
