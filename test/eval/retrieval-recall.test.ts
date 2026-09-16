// Retrieval quality, measured (19-value-to-a-user.md, Phase 1).
//
// The three tests that guarded ranking before this file could not fail. Each
// ran a two-document corpus with a limit of five or six, so both documents came
// back for any query and a `toContain` assertion was true whatever the order
// was — including reversed, which is what item 7 of that audit found the order
// actually to be. This file exists so ranking is a number rather than a hand-run
// query, and so a change to it reads as a diff.
//
// It ranks the real thing: a real better-sqlite3 file, the real sqlite-vec
// extension, real FTS5, and the pinned transformers.js embedder loaded offline
// the way test/support/model-cache.ts arranges. No model call, no network, no
// fixture — the corpus and the query labels are the only hand-written input.
//
// Both callers are measured through the function they actually call.
// `claim`-shaped queries go through `findNeighbours`, which is what the write
// path hands a candidate; `question`-shaped ones go through `searchSignposts`,
// which is what the MCP server answers with.
//
// **Metrics.** recall@5 and MRR, and the choice of five is not cosmetic:
// `classify` is shown the top five and the MCP default limit is five, so a
// relevant signpost at rank six does not exist as far as this product is
// concerned. recall@5 answers "did it come back at all", MRR answers "how far
// down", which is the difference between item 7 and an ordinary miss.
//
// nDCG was considered and dropped. It needs graded relevance, which is a second
// judgement over every query/document pair, and there is no decision here it
// would change.
//
// **Measured 2026-09-16, before any ranking change:**
//
//   recall@5  0.958   23 of 24 queries. The miss is item 7's own query, which
//                     did not return staging-db-read-only at all
//   MRR       0.938
//   no-match  0/4     every query relevant to nothing returned five rows
//
// **After Phase 2** — stopwords dropped from the FTS query, the lexical list
// weighted below the vector list, both retrievers over-fetched, and a cosine
// floor on the read path:
//
//   recall@5  1.000   24 of 24
//   MRR       0.951
//   no-match  4/4     all four return zero rows
//
// Two queries sit at rank 3 and stay there, and it is worth knowing why they
// are not a ranking bug. "Is it safe to apply schema changes to the
// pre-production environment" gets cosine 0.435 for dev-db-reset-drops-tables
// and 0.311 for staging-db-read-only: all-MiniLM-L6-v2 reads "safe" and
// "database" as closer than "pre-production" is to "staging". No weighting of
// two rank lists moves that, and a better embedding model would. What Phase 2
// did fix is the thing item 7 was about — staging-warehouse-writable, which
// says the opposite of the right answer, is now nowhere in the top five.
//
// If this file ever passes on day one against a ranking change nobody measured,
// the corpus is too small or the queries are too easy. The response is to make
// them harder, not to move the thresholds.

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMBEDDING_MODEL, NEIGHBOUR_K } from "../../src/core/config/constants.ts";
import { normalize } from "../../src/core/retrieval/normalize.ts";
import { findNeighbours } from "../../src/io/db/neighbours.ts";
import { searchSignposts } from "../../src/io/db/search-signposts.ts";
import { openDb } from "../../src/io/db/migrate.ts";
import { rebuildIndex } from "../../src/io/db/vector-index.ts";
import { createEmbedder, type Embedder } from "../../src/io/embed/embedder.ts";
import { testLocalModelPath, testModelCache } from "../support/model-cache.ts";
import { EVAL_CORPUS, EVAL_REPO } from "./retrieval/corpus.ts";
import { EVAL_QUERIES, NO_MATCH_QUERIES, RELEVANT_QUERIES, type EvalQuery } from "./retrieval/queries.ts";

/** What both callers are given, and what both metrics are cut at. */
const LIMIT = 5;

const MIN_RECALL_AT_5 = 0.9;
const MIN_MRR = 0.75;

const retrieval = { allow_remote_models: false, local_model_path: testLocalModelPath() };
const modelCacheRoot = testModelCache();

let dir: string;
let db: Database.Database;
let embedder: Embedder;
/** Query id -> the ranked corpus ids that query returned, best first. */
const ranked = new Map<string, string[]>();

function insertSignpost(id: string, claim: string, evidence: string, contentHash: string): void {
  db.prepare(
    `INSERT INTO signposts
      (id, repo, claim, category, evidence, scope_json, confidence, status, provenance_json, is_pending, content_hash, embedding_model, embedding_dim)
     VALUES (?, ?, ?, 'gotcha', ?, ?, 0.9, 'active', '{}', 0, ?, '', 0)`,
  ).run(id, EVAL_REPO, claim, evidence, JSON.stringify({ repo: EVAL_REPO }), contentHash);
}

/**
 * Runs one query through the path its shape belongs to. A `claim` query is what
 * `findNeighbours` receives from the write path; a `question` is what the MCP
 * server passes to `searchSignposts`. Neither is given `paths`, so the
 * path-overlap boost is zero for every row and what is left is the ranking.
 */
async function run(query: EvalQuery): Promise<string[]> {
  const [embedding] = await embedder.embed([normalize(query.text)]);
  const candidate = { claim: query.text, embedding: embedding! };
  return query.shape === "claim"
    ? findNeighbours(db, EVAL_REPO, candidate, LIMIT).map((n) => n.id)
    : searchSignposts(db, EVAL_REPO, candidate, LIMIT).map((h) => h.id);
}

/** Share of a query's relevant ids that made the top `LIMIT`. */
function recallAt5(query: EvalQuery): number {
  const hits = ranked.get(query.id)!.filter((id) => query.relevant.includes(id));
  return hits.length / query.relevant.length;
}

/** 1/rank of the first relevant id, or 0 when none of them came back. */
function reciprocalRank(query: EvalQuery): number {
  const index = ranked.get(query.id)!.findIndex((id) => query.relevant.includes(id));
  return index === -1 ? 0 : 1 / (index + 1);
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

describe("retrieval quality", () => {
  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "signposts-retrieval-eval-"));
    db = openDb(path.join(dir, "signposts.db"));
    for (const s of EVAL_CORPUS) {
      insertSignpost(s.id, s.claim, s.evidence, s.content_hash);
    }
    await rebuildIndex(db, { modelCacheDir: modelCacheRoot, retrieval, repo: EVAL_REPO, signposts: EVAL_CORPUS });

    embedder = await createEmbedder({
      modelCacheDir: modelCacheRoot,
      allowRemoteModels: retrieval.allow_remote_models,
      localModelPath: retrieval.local_model_path,
      embeddingModel: EMBEDDING_MODEL,
    });

    // Every query is run once here rather than per test, so the metrics and the
    // per-query diagnostics below read the same ranking and one embedder load
    // covers the file.
    for (const query of EVAL_QUERIES) {
      ranked.set(query.id, await run(query));
    }

    // Printed, not only asserted. The thresholds below say pass or fail; a run
    // that moves recall@5 from 0.958 to 1.000 passes either way, and the number
    // is what tells whoever changed the ranking which way it moved.
    const recall = mean(RELEVANT_QUERIES.map(recallAt5));
    const mrr = mean(RELEVANT_QUERIES.map(reciprocalRank));
    const answered = NO_MATCH_QUERIES.filter((query) => ranked.get(query.id)!.length === 0).length;
    console.log(
      `retrieval eval: recall@${LIMIT}=${recall.toFixed(3)} MRR=${mrr.toFixed(3)} ` +
        `no-match=${answered}/${NO_MATCH_QUERIES.length} over ${EVAL_CORPUS.length} signposts`,
    );
  }, 300_000);

  afterAll(() => {
    db?.close();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(`recall@${LIMIT} is at least ${MIN_RECALL_AT_5}`, () => {
    const perQuery = RELEVANT_QUERIES.map((query) => ({ query, score: recallAt5(query) }));
    const missed = perQuery.filter((entry) => entry.score === 0).map((entry) => entry.query.id);
    const score = mean(perQuery.map((entry) => entry.score));

    // Named in the assertion rather than logged, so a failure says which
    // queries lost their answer without anyone re-running the file.
    expect({ recallAt5: score.toFixed(3), missed }).toEqual({
      recallAt5: expect.any(String),
      missed: [],
    });
    expect(score).toBeGreaterThanOrEqual(MIN_RECALL_AT_5);
  });

  it(`MRR is at least ${MIN_MRR}`, () => {
    const perQuery = RELEVANT_QUERIES.map((query) => ({
      id: query.id,
      rank: ranked.get(query.id)!.findIndex((id) => query.relevant.includes(id)) + 1,
    }));
    const score = mean(RELEVANT_QUERIES.map(reciprocalRank));
    const belowTop = perQuery.filter((entry) => entry.rank !== 1);

    expect({ mrr: score.toFixed(3), belowTop }).toMatchObject({ mrr: expect.any(String) });
    expect(score).toBeGreaterThanOrEqual(MIN_MRR);
  });

  it("a query whose subject is not in the corpus returns nothing", () => {
    const answered = NO_MATCH_QUERIES.map((query) => ({ id: query.id, returned: ranked.get(query.id)! })).filter(
      (entry) => entry.returned.length > 0,
    );
    expect(answered).toEqual([]);
  });

  it("ranks the same way whatever limit the caller asks for", async () => {
    // RETRIEVAL_POOL, stated as the invariant it exists for
    // (19-value-to-a-user.md item 9). With the pool equal to the limit, ranks
    // 2-5 reshuffled between k=5 and k=20 on most write-path queries while
    // rank 1 held — invisible to MRR, and exactly what `classify` is shown.
    //
    // Every query and several limits, not one of each. The first version of
    // this test checked a single question at 5 and 20, happened to pick one
    // that was stable, and passed against the unfixed ranking.
    const limits = [1, 2, 3, LIMIT, NEIGHBOUR_K, LIMIT * 4];
    const unstable: string[] = [];
    for (const query of EVAL_QUERIES) {
      const [embedding] = await embedder.embed([normalize(query.text)]);
      const candidate = { claim: query.text, embedding: embedding! };
      const at = (k: number): string[] =>
        query.shape === "claim"
          ? findNeighbours(db, EVAL_REPO, candidate, k).map((n) => n.id)
          : searchSignposts(db, EVAL_REPO, candidate, k).map((hit) => hit.id);

      const widest = at(Math.max(...limits));
      for (const k of limits) {
        const narrow = at(k);
        if (JSON.stringify(narrow) !== JSON.stringify(widest.slice(0, narrow.length))) {
          unstable.push(`${query.id} at limit ${k}`);
        }
      }
    }
    expect(unstable).toEqual([]);
  }, 120_000);

  it("a differently worded restatement retrieves its signpost as the top neighbour", () => {
    // 05-retrieval.md's first acceptance criterion, as position rather than
    // membership. It is stated about a *candidate* — what the write path checks
    // for a duplicate — so it is asserted on the claim-shaped query, which is
    // what findNeighbours receives.
    expect(ranked.get("claim-staging-migrations")![0]).toBe("staging-db-read-only");
  });

  it("the near-miss that contradicts the answer never outranks it", () => {
    // 19-value-to-a-user.md item 7. The corpus holds staging-warehouse-writable
    // — "the staging warehouse replica is writable" — as the deliberate near
    // miss: same subject, opposite claim. A model asking whether it may migrate
    // staging was handed that above "staging is read-only", which is worse than
    // returning nothing.
    //
    // Checked over every query the answer is a staging claim for, not only the
    // one the audit ran by hand.
    for (const id of ["question-staging-schema-change", "claim-staging-migrations"]) {
      const order = ranked.get(id)!;
      const answer = order.indexOf("staging-db-read-only");
      const nearMiss = order.indexOf("staging-warehouse-writable");
      expect({ id, answer, beatsNearMiss: nearMiss === -1 || answer < nearMiss }).toEqual({
        id,
        answer: expect.any(Number),
        beatsNearMiss: true,
      });
      expect(answer).not.toBe(-1);
    }
  });
});
