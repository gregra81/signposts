// IO-level neighbour retrieval for the write-path duplicate/contradiction
// check: wires the pure core (RRF fusion, path-overlap boost) to the real
// signpost_vec / signpost_fts tables. See 05-retrieval.md "Hybrid search" /
// "Filter before you search" and 16-build-plan.md's core/io split —
// everything decision-shaped lives in src/core/retrieval/, this file is
// glue plus the actual queries.
//
// Hard filters (repo, status='active') are applied inside the queries
// themselves. The write path takes no similarity floor; the read path takes
// one (RankOptions.minSimilarity, and READ_MIN_SIMILARITY for why the two
// differ). Either way, if the fused, filtered result is empty or short of k,
// that is returned as-is; nothing pads it out.
//
// `is_pending` is the one filter that differs by caller, so it is an option
// rather than part of the constant below: the write path must see what an
// earlier session in the same run proposed (06-review-and-pr.md), and the read
// path must not — a proposal a person may still reject is not recorded
// knowledge (./search-signposts.ts).

import type Database from "better-sqlite3";
import { MIN_SIMILARITY, RETRIEVAL_POOL } from "../../core/config/constants.ts";
import { combineScore } from "../../core/retrieval/combine-score.ts";
import { cosineFromL2Distance } from "../../core/retrieval/vector-similarity.ts";
import { ftsQuery } from "../../core/retrieval/fts-query.ts";
import { pathOverlapBoost } from "../../core/retrieval/path-overlap.ts";
import { fuseRrf } from "../../core/retrieval/rrf.ts";
import { vectorToBlob } from "../../core/retrieval/vector-codec.ts";
import { PENDING_STATES, type PendingState } from "../../core/contracts/graph.ts";
import { ACTIVE_STATUS, scopeSchema, type Scope } from "../../core/signpost/schema.ts";

// Shared by both queries below — the "hard filter" half of the "Hard
// filters (repo, status='active')" contract, kept in one place so the two
// prepared statements can't drift apart.
const ACTIVE_IN_REPO_FILTER = "signpost_id IN (SELECT id FROM signposts WHERE repo = ? AND status = ?";

/** Both queries take the same filter, with or without the pending half. */
function activeInRepoFilter(includePending: boolean): string {
  return `${ACTIVE_IN_REPO_FILTER}${includePending ? "" : " AND is_pending = 0"})`;
}

export interface RankOptions {
  /**
   * Whether rows a run has proposed and not merged are eligible. Defaults to
   * true, which is the write path's contract: `classify` is shown them.
   */
  includePending: boolean;
  /**
   * Cosine floor a row's claim must clear against the query, or `undefined` for
   * no floor at all. The two paths want opposite things and the reason is in
   * constants.ts next to MIN_SIMILARITY and READ_MIN_SIMILARITY: an empty
   * neighbour list is information `classify` acts on, an empty search result is
   * the honest answer to a question the corpus does not cover.
   *
   * It filters the vector candidates only. A row that reached the fusion from
   * FTS alone matched actual tokens of the query — after stopwords were dropped
   * (../../core/retrieval/fts-query.ts), that is a lexical hit on a content
   * word, which is the rare-identifier case 05-retrieval.md keeps the lexical
   * half for. Scoring it by cosine and dropping it would throw away exactly the
   * match the hybrid exists to catch.
   */
  minSimilarity: number | undefined;
}

const WRITE_PATH_OPTIONS: RankOptions = { includePending: true, minSimilarity: MIN_SIMILARITY };

export interface NeighbourCandidate {
  /** Already-normalised, already-embedded claim text — see normalize.ts / the embedder. */
  claim: string;
  embedding: readonly number[];
  /** Candidate's scope.paths, if any — fed to the path-overlap boost (R2). */
  paths?: readonly string[];
}

/**
 * What `rankSignposts` searches for. The read path's embedding can be null:
 * when the embedder will not load, or the index was built with another model,
 * the FTS half still answers on its own (19-value-to-a-user.md item 12). The
 * write path always embeds, which is why NeighbourCandidate does not allow it.
 */
export interface RankQuery {
  claim: string;
  embedding: readonly number[] | null;
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

/** The vector half's rows, which carry the distance the read-path floor reads. */
interface VectorRow extends SignpostIdRow {
  distance: number;
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

/**
 * A row's scope, or `undefined` when the column no longer parses — the row is
 * then dropped rather than thrown on, exactly as ./signposts.ts's `toSignpost`
 * already does and for the same reason it learned to: `JSON.parse` and
 * `scopeSchema.parse` both throw, this runs once per candidate on the write
 * path and once per query on the read path, and one row written by an older
 * build took down every retrieval in that repo until someone worked out that
 * `signpost index` needed re-running. On the read path it would not even have
 * said that much: the MCP server catches the throw and answers "nothing".
 */
function parseScope(scopeJson: string): Scope | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(scopeJson);
  } catch {
    return undefined;
  }
  const parsed = scopeSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
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
 *
 * Each retriever is asked for RETRIEVAL_POOL candidates (or `k`, if that is
 * larger) and the fusion is sliced to `k` at the very end, so `k` is a page size
 * and not also the pool. For any `k` up to RETRIEVAL_POOL, the result is a
 * prefix of one ranking, and the order does not move when the limit does.
 */
export function rankSignposts(
  db: Database.Database,
  repo: string,
  candidate: RankQuery,
  k: number,
  options: RankOptions = WRITE_PATH_OPTIONS,
): RankedRow[] {
  if (k <= 0) {
    return [];
  }

  const pool = Math.max(k, RETRIEVAL_POOL);

  const vectorRows =
    candidate.embedding === null
      ? []
      : (db
          .prepare(
            `SELECT signpost_id, distance
             FROM signpost_vec
             WHERE repo = ? AND claim_embedding MATCH ? AND k = ?
               AND ${activeInRepoFilter(options.includePending)}
             ORDER BY distance`,
          )
          .all(repo, vectorToBlob(candidate.embedding), pool, repo, ACTIVE_STATUS) as VectorRow[]);

  const { minSimilarity } = options;
  const nearEnough =
    minSimilarity === undefined
      ? vectorRows
      : vectorRows.filter((row) => cosineFromL2Distance(row.distance) >= minSimilarity);

  const query = ftsQuery(candidate.claim);
  const ftsRows =
    query === null
      ? []
      : (db
          .prepare(
            `SELECT signpost_id
             FROM signpost_fts
             WHERE repo = ? AND signpost_fts MATCH ?
               AND ${activeInRepoFilter(options.includePending)}
             ORDER BY bm25(signpost_fts)
             LIMIT ?`,
          )
          .all(repo, query, repo, ACTIVE_STATUS, pool) as SignpostIdRow[]);

  const fused = fuseRrf(
    nearEnough.map((row) => row.signpost_id),
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
      const scope = parseScope(row.scope_json);
      if (scope === undefined) {
        return null;
      }
      const boost = pathOverlapBoost(candidate.paths, scope.paths);
      return { row, scope, score: combineScore(entry.score, boost) };
    })
    .filter((entry): entry is RankedRow => entry !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
