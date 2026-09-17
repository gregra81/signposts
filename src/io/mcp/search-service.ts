// The read path behind the `search_signposts` MCP tool: resolve the repo,
// open the index read-only, check it is current, embed the query, search.
//
// **What can be searched, is.** A stale index, an index built with another
// model and an embedder that will not load each still leave something to
// search, so each searches it and says what it could not do
// (19-value-to-a-user.md item 12). Only the states with nothing to search —
// no repo, no database, no index, an unreadable one — come back empty.
//
// **Nothing here throws.** Every step that can fail returns one of
// src/core/mcp/search-tool.ts's reasons instead, because the caller of this is
// a tool call inside a Claude turn and the states it can be in — no origin
// remote, no database, an index the worker has not rebuilt yet, no model cache
// — are all ordinary for a reader who cloned the repo this morning
// (05-retrieval.md, "The MCP server on a cold clone"). The last `catch` is
// deliberately broad for the same reason: an unforeseen failure still has to
// leave Claude with the fallback, not with a stack trace.
//
// The database is opened per call and closed again; the embedder is built once
// and kept. That split is what each costs: opening SQLite is microseconds and
// re-opening is how a search made an hour into a session sees the index the
// background worker rebuilt ten minutes ago, while building the embedder loads
// an ONNX pipeline and paying that per query would be seconds each time.

import type { ResolvedConfig } from "../../core/config/resolve.ts";
import { EMBEDDING_MODEL } from "../../core/config/constants.ts";
import {
  SEARCH_UNAVAILABLE,
  searchOutput,
  unavailableOutput,
  type SearchToolOutput,
  type SearchUnavailable,
} from "../../core/mcp/search-tool.ts";
import { normalize } from "../../core/retrieval/normalize.ts";
import { openReadOnlyDb } from "../db/read-only.ts";
import { indexState, searchSignposts } from "../db/search-signposts.ts";
import { createEmbedder, type Embedder } from "../embed/embedder.ts";
import { resolveRepo } from "../git/remote-origin.ts";

export interface SearchInput {
  query: string;
  /** The caller's working set, if it named one — feeds the path-overlap boost. */
  paths?: readonly string[];
  limit: number;
}

export interface SearchService {
  search(input: SearchInput): Promise<SearchToolOutput>;
}

export interface CreateSearchServiceInput {
  config: ResolvedConfig;
  repoRoot: string;
  /** Where a failure's detail goes. Never stdout: that is the JSON-RPC wire. */
  warn: (message: string) => void;
}

export function createSearchService({ config, repoRoot, warn }: CreateSearchServiceInput): SearchService {
  // Both resolved lazily, and both kept: the repo key costs a `git` subprocess
  // and the embedder costs a model load, and neither changes for the life of
  // the process. Resolving them at construction would also mean doing it
  // before any client has connected — work a server that is never asked
  // anything should not do.
  let repo: string | null | undefined;
  let embedder: Embedder | undefined;

  async function embedQuery(query: string): Promise<readonly number[] | null> {
    try {
      embedder ??= await createEmbedder({
        modelCacheDir: config.paths.modelCacheDir,
        allowRemoteModels: config.retrieval.allow_remote_models,
        localModelPath: config.retrieval.local_model_path,
        embeddingModel: EMBEDDING_MODEL,
      });
      const [vector] = await embedder.embed([normalize(query)]);
      return vector ?? null;
    } catch (error) {
      warn(`signposts: could not embed the query: ${String(error)}`);
      return null;
    }
  }

  return {
    async search(input: SearchInput): Promise<SearchToolOutput> {
      try {
        repo ??= resolveRepo(repoRoot);
        if (repo === null) {
          return unavailableOutput(SEARCH_UNAVAILABLE.no_repo);
        }

        // Two different things to say, and one of them is not a fault: no
        // file at all is a checkout nothing has run in, while a file this
        // build cannot read is a schema worth naming (../db/read-only.ts).
        const opened = openReadOnlyDb(config.paths.dbPath);
        if (opened.status === "missing") {
          return unavailableOutput(SEARCH_UNAVAILABLE.no_index);
        }
        if (opened.status === "unreadable") {
          return unavailableOutput(SEARCH_UNAVAILABLE.unreadable);
        }

        const db = opened.db;
        try {
          // `init` creates the database and does not index, so "there is a
          // database" and "there is an index" are separate questions and a
          // repo that has only consented is in the first state, not stale.
          const state = indexState(db, repo);
          if (state === "missing") {
            return unavailableOutput(SEARCH_UNAVAILABLE.not_indexed);
          }

          const caveats: SearchUnavailable[] = [];
          let embedding: readonly number[] | null = null;
          if (state === "model_changed") {
            // Not even loaded: the query's vector would be in a space the
            // index's vectors are not.
            caveats.push(SEARCH_UNAVAILABLE.model_changed);
          } else {
            if (state === "stale") {
              caveats.push(SEARCH_UNAVAILABLE.stale_index);
            }
            embedding = await embedQuery(input.query);
            if (embedding === null) {
              caveats.push(SEARCH_UNAVAILABLE.no_embedder);
            }
          }

          const candidate = {
            claim: input.query,
            embedding,
            ...(input.paths === undefined ? {} : { paths: input.paths }),
          };
          return searchOutput(searchSignposts(db, repo, candidate, input.limit), caveats);
        } finally {
          db.close();
        }
      } catch (error) {
        warn(`signposts: search failed: ${String(error)}`);
        return unavailableOutput(SEARCH_UNAVAILABLE.unreadable);
      }
    },
  };
}
