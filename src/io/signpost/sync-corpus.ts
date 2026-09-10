// The corpus on disk, made the corpus the index answers from: parse every
// `.signposts/**/*.md`, mirror the active ones, and rebuild the vector/FTS
// index if the corpus moved.
//
// This used to live inside `signpost index` and nowhere else, and
// 18-end-to-end-gaps.md item 2 is what that cost. 05-retrieval.md says the
// index self-heals — "`signpost index` is a manual escape hatch, not a
// required step" — but nothing on the run path called either half, so a repo
// that had merged a pull request full of signposts and not run the command by
// hand handed `classify` an empty neighbour list. Everything came back NOVEL
// because everything looked unprecedented, and `DUPLICATE`, `REFINEMENT`,
// `CONTRADICTION`, `resolve_conflict` and `reinforce` were all unreachable
// from a session driven by the skill, which never mentions the command.
//
// **It is only safe at the start of a run, and that is why the run path calls
// it exactly where it clears pending rows.** `mirrorSignposts` deletes every
// row for the repo that is not on disk, and a pending row never is — so a
// sync in the middle of a run would delete what the earlier sessions of that
// run proposed (src/io/db/pending-index.ts). The one moment when that is the
// intent is `run --first`, which is already the moment `clearPending` runs.
//
// The rebuild is cheap when nothing moved: `rebuildIndex` consults
// `shouldReindex` first and returns without constructing an embedder when the
// corpus hash and the embedding model both match.

import { describeError } from "../../core/errors/format-zod-error.ts";
import { parseSignpost } from "../../core/signpost/codec.ts";
import { contentHashFor } from "../../core/signpost/content-hash.ts";
import { ACTIVE_STATUS, type Signpost } from "../../core/signpost/schema.ts";
import { mirrorSignposts } from "../db/signposts.ts";
import { rebuildIndex, type ActiveSignpost, type RebuildIndexOptions } from "../db/vector-index.ts";
import { readSignpostFiles } from "./read-dir.ts";
import type Database from "better-sqlite3";

export interface SyncCorpusInput {
  db: Database.Database;
  /** The "owner/name" key every row and the index_meta row are filed under. */
  repo: string;
  knowledgeDir: string;
  modelCacheDir: string;
  retrieval: RebuildIndexOptions["retrieval"];
}

export interface SyncCorpusResult {
  /** Every signpost that parsed, whatever its status — what `index.md` lists. */
  parsed: Signpost[];
  /** One line per file that did not parse, ready to print. Empty when all did. */
  failures: string[];
}

/**
 * Reads the corpus off disk and brings the mirror and the index up to it.
 *
 * A file that does not parse is reported and skipped rather than thrown on:
 * one malformed signpost must not take the index — or a run — down with it.
 * The caller decides what a failure means; `signpost index` turns it into an
 * exit code, and the run path only warns.
 */
export async function syncCorpus(input: SyncCorpusInput): Promise<SyncCorpusResult> {
  const parsed: Signpost[] = [];
  const failures: string[] = [];

  for (const file of readSignpostFiles(input.knowledgeDir)) {
    try {
      parsed.push(parseSignpost(file.content));
    } catch (error) {
      failures.push(`skipping ${file.path}: ${describeError(error)}`);
    }
  }

  const activeWithHash = parsed
    .filter((signpost) => signpost.status === ACTIVE_STATUS)
    .map((signpost) => ({ signpost, contentHash: contentHashFor(signpost) }));

  mirrorSignposts(input.db, input.repo, activeWithHash);

  const signposts: ActiveSignpost[] = activeWithHash.map(({ signpost, contentHash }) => ({
    id: signpost.id,
    content_hash: contentHash,
    claim: signpost.claim,
    evidence: signpost.evidence,
  }));
  await rebuildIndex(input.db, {
    modelCacheDir: input.modelCacheDir,
    retrieval: input.retrieval,
    repo: input.repo,
    signposts,
  });

  return { parsed, failures };
}
