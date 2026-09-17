// The read path: the same hybrid retrieval the write path uses
// (./neighbours.ts), projected into 12-wire-contracts.md's MCP shape, plus
// the check that says whether the index is worth searching at all.
//
// **Merged rows only, on both halves.** `signposts` holds two kinds of row:
// what `signpost index` mirrored off disk, and what a run has proposed and not
// yet merged (`is_pending = 1`, ./pending-index.ts). The second kind exists so
// `classify` can see what an earlier session in the same run proposed; it is
// not recorded team knowledge, and a proposal a person may still reject must
// not come back to a reader as though it were. It also must not count towards
// the corpus hash: `rebuildIndex` is fed the rows parsed off disk, so a corpus
// hash taken over pending rows too disagrees with `index_meta` from the moment
// a run proposes anything — which reported the whole index stale, and pointed
// the reader at `signpost index`, whose run would have deleted the in-flight
// run's pending rows.
//
// **Fresh is measured against the mirror, not against disk.** `shouldReindex`
// compares the corpus hash recorded in `index_meta` with the hash of the
// merged rows in `signposts` — so this reports stale exactly when the vectors
// and the FTS rows no longer describe what the mirror holds, which is the
// condition `signpost index` acts on (./vector-index.ts). A `git pull` that
// brings a teammate's markdown in leaves both halves agreeing until an `index`
// run picks the files up, and that run is not this process's to trigger: the
// session-start hook wakes the worker for it (05-retrieval.md, "The
// `SessionStart` hook builds it") at the same moment a Claude session — and
// therefore this server — starts. Re-hashing every file on disk per query
// would buy a sharper answer to a question that resolves itself seconds later,
// once per tool call, forever.

import type Database from "better-sqlite3";
import { EMBEDDING_MODEL, READ_MIN_SIMILARITY } from "../../core/config/constants.ts";
import type { SignpostHit } from "../../core/mcp/search-tool.ts";
import { computeCorpusHash } from "../../core/retrieval/corpus-hash.ts";
import { shouldReindex } from "../../core/retrieval/reindex-decision.ts";
import { ACTIVE_STATUS } from "../../core/signpost/schema.ts";
import { rankSignposts, type RankQuery } from "./neighbours.ts";

interface CorpusRow {
  id: string;
  content_hash: string;
}

interface IndexMetaRow {
  corpus_hash: string;
  embedding_model: string;
}

/**
 * What state `repo`'s vector/FTS index is in.
 *
 * `missing` and `stale` are separate because they are separate things to tell
 * a reader, and one of them is the ordinary case: `signpost init` creates the
 * database and does not index, so a repo that has consented and nothing more
 * has a database, no `index_meta` row, and nothing recorded. Folding that into
 * `shouldReindex` — which answers true for it, since a missing index is one of
 * its three triggers — told that repo its index was "out of date with the
 * recorded signposts" when it had recorded none.
 *
 * `model_changed` is split out of `stale` because the two can be searched
 * differently. A corpus that moved on still has vectors in the query's space
 * for every signpost it was built from; vectors from another model do not, and
 * comparing across the two spaces is the thing 05-retrieval.md's rebuild
 * trigger exists to prevent. So only the FTS half is searched there.
 */
export type IndexState = "missing" | "model_changed" | "stale" | "current";

export function indexState(db: Database.Database, repo: string): IndexState {
  const meta = db.prepare("SELECT corpus_hash, embedding_model FROM index_meta WHERE repo = ?").get(repo) as
    | IndexMetaRow
    | undefined;
  if (meta === undefined) {
    return "missing";
  }
  if (meta.embedding_model !== EMBEDDING_MODEL) {
    return "model_changed";
  }

  const corpus = db
    .prepare("SELECT id, content_hash FROM signposts WHERE repo = ? AND status = ? AND is_pending = 0")
    .all(repo, ACTIVE_STATUS) as CorpusRow[];

  const stale = shouldReindex({
    indexExists: true,
    storedCorpusHash: meta.corpus_hash,
    currentCorpusHash: computeCorpusHash(corpus),
    storedEmbeddingModel: meta.embedding_model,
    currentEmbeddingModel: EMBEDDING_MODEL,
  });

  return stale ? "stale" : "current";
}

/**
 * Up to `limit` merged, active signposts for `query`, best first. `paths` is
 * the caller's working set, fed to the same path-overlap boost the write path
 * uses — a signpost scoped to a file you are editing outranks a near-peer that
 * is not.
 */
export function searchSignposts(
  db: Database.Database,
  repo: string,
  candidate: RankQuery,
  limit: number,
): SignpostHit[] {
  return rankSignposts(db, repo, candidate, limit, {
    includePending: false,
    // The read path's floor, and the one place the two paths' opposite answers
    // to "what does no neighbour mean" are chosen between. See
    // READ_MIN_SIMILARITY in ../../core/config/constants.ts.
    minSimilarity: READ_MIN_SIMILARITY,
  }).map(({ row, score }) => ({
    id: row.id,
    claim: row.claim,
    category: row.category,
    evidence: row.evidence,
    confidence: row.confidence,
    score,
  }));
}
