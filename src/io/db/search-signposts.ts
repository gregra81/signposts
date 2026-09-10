// The read path: the same hybrid retrieval the write path uses
// (./neighbours.ts), projected into 12-wire-contracts.md's MCP shape, plus
// the check that says whether the index is worth searching at all.
//
// **Fresh is measured against the mirror, not against disk.** `shouldReindex`
// compares the corpus hash recorded in `index_meta` with the hash of the rows
// in `signposts` — so this reports stale exactly when the vectors and the FTS
// rows no longer describe what the mirror holds, which is the condition
// `signpost index` acts on (./vector-index.ts). A `git pull` that brings a
// teammate's markdown in leaves both halves agreeing until an `index` run
// picks the files up, and that run is not this process's to trigger: the
// session-start hook wakes the worker for it (05-retrieval.md, "The
// `SessionStart` hook builds it") at the same moment a Claude session — and
// therefore this server — starts. Re-hashing every file on disk per query
// would buy a sharper answer to a question that resolves itself seconds later,
// once per tool call, forever.

import type Database from "better-sqlite3";
import { EMBEDDING_MODEL } from "../../core/config/constants.ts";
import type { SignpostHit } from "../../core/mcp/search-tool.ts";
import { computeCorpusHash } from "../../core/retrieval/corpus-hash.ts";
import { shouldReindex } from "../../core/retrieval/reindex-decision.ts";
import { ACTIVE_STATUS } from "../../core/signpost/schema.ts";
import { rankSignposts, type NeighbourCandidate } from "./neighbours.ts";

interface CorpusRow {
  id: string;
  content_hash: string;
}

interface IndexMetaRow {
  corpus_hash: string;
  embedding_model: string;
}

/**
 * Whether `repo`'s vector/FTS index matches the signposts recorded for it —
 * the same decision, on the same inputs, that `rebuildIndex` makes before it
 * rebuilds anything.
 */
export function indexIsCurrent(db: Database.Database, repo: string): boolean {
  const corpus = db
    .prepare("SELECT id, content_hash FROM signposts WHERE repo = ? AND status = ?")
    .all(repo, ACTIVE_STATUS) as CorpusRow[];

  const meta = db.prepare("SELECT corpus_hash, embedding_model FROM index_meta WHERE repo = ?").get(repo) as
    | IndexMetaRow
    | undefined;

  return !shouldReindex({
    indexExists: meta !== undefined,
    storedCorpusHash: meta?.corpus_hash ?? null,
    currentCorpusHash: computeCorpusHash(corpus),
    storedEmbeddingModel: meta?.embedding_model ?? null,
    currentEmbeddingModel: EMBEDDING_MODEL,
  });
}

/**
 * Up to `limit` active signposts for `query`, best first. `paths` is the
 * caller's working set, fed to the same path-overlap boost the write path
 * uses — a signpost scoped to a file you are editing outranks a near-peer
 * that is not.
 */
export function searchSignposts(
  db: Database.Database,
  repo: string,
  candidate: NeighbourCandidate,
  limit: number,
): SignpostHit[] {
  return rankSignposts(db, repo, candidate, limit).map(({ row, score }) => ({
    id: row.id,
    claim: row.claim,
    category: row.category,
    evidence: row.evidence,
    confidence: row.confidence,
    score,
  }));
}
