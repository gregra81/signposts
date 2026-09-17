// What the MCP tool says, in every case it can be in (10-roadmap.md Phase
// 6.5, 05-retrieval.md "The MCP server on a cold clone", 12-wire-contracts.md
// "MCP tool"). Pure: the query, the database and the embedder are the IO
// half's business (src/io/mcp/), and this module only decides what comes back.
//
// **The tool never fails.** A missing index is the ordinary state of a fresh
// clone — the reader installed the plugin, has run no extraction and holds no
// credential — and an MCP tool that throws there puts an error inside a Claude
// turn for a condition that is nobody's mistake. So a path with nothing to
// search is an empty result plus a diagnostic saying which one it is and what
// still works: `.signposts/` is markdown on disk and the CLAUDE.md pointer
// sends Claude to read it, which is why 15-spec.md story 62 keeps that pointer
// after this server ships.
//
// **A path with something to search answers, and says what it could not do.**
// A stale index, an embedder that will not load and an index built with
// another model all used to return nothing (19-value-to-a-user.md item 12). A
// stale index still holds every signpost it was built from, and the FTS half
// needs no model, so each of those now searches what it can and carries the
// reason as a caveat beside the hits.
//
// The diagnostic is written for the model reading it, not for a log: it says
// what to do instead, because the alternative is Claude concluding the repo
// has no recorded knowledge.

import { z } from "zod";
import { SIGNPOSTS_DIRNAME, INDEX_FILENAME } from "../config/constants.ts";

export const SEARCH_TOOL_NAME = "search_signposts";

/**
 * `limit`'s default (12-wire-contracts.md, "MCP tool":
 * `search_signposts(query, paths?, limit? = 5)`).
 *
 * Local rather than a ../config/constants.ts export, and deliberately: that
 * module is the repo's tuning surface, and every literal under `src/` equal to
 * something exported from it is a lint error (eslint-rules/no-magic-literal.js).
 * Putting a small integer like this there makes the unrelated `5`s in the
 * codebase — an exit code, for one — errors overnight. It is also not a knob
 * 13-constants.md governs: it is this tool's signature, and it belongs with it.
 */
export const DEFAULT_SEARCH_LIMIT = 5;

export const SEARCH_TOOL_TITLE = "Search signposts";

/**
 * Shown to the model when it chooses a tool, so it names the corpus rather
 * than the mechanism: "team knowledge you cannot infer from the code" is the
 * thing worth a call, "hybrid vector + FTS retrieval" is not.
 */
export const SEARCH_TOOL_DESCRIPTION =
  `Search this repository's reviewed team knowledge — the durable gotchas, conventions and ` +
  `constraints recorded in ${SIGNPOSTS_DIRNAME}/ that cannot be inferred from the code. ` +
  `Ask it before infrastructure, migration or deployment work, and whenever a decision looks ` +
  `like one someone has already made here. Returns the closest signposts by meaning, not by keyword.`;

/**
 * Why a search came back empty or incomplete. Every value is a state the reader
 * is allowed to be in, not a fault — see the module header. The first group
 * leaves nothing to search; the second is a caveat on results that still come
 * back (`searchOutput`'s `caveats`).
 */
export const SEARCH_UNAVAILABLE = {
  /** No `origin` remote to key the corpus on: signposts are stored per repo. */
  no_repo: "no_repo",
  /** No database file. The cold clone, before the first index build. */
  no_index: "no_index",
  /**
   * A database and no index. `init` creates the one and never builds the
   * other, so every repo that has consented passes through here — which is
   * not a fresh clone, and must not be told it is.
   */
  not_indexed: "not_indexed",
  /** A database that cannot be read at the schema this build expects. */
  unreadable: "unreadable",
  /** Everything worked and nothing was close enough to the query. */
  no_match: "no_match",
  /** Caveat: the index is behind the recorded corpus, and was searched anyway. */
  stale_index: "stale_index",
  /** Caveat: the index was built with another embedding model, so only its FTS half was searched. */
  model_changed: "model_changed",
  /** Caveat: the embedder would not load — no model cache, offline — so only the FTS half was searched. */
  no_embedder: "no_embedder",
} as const;

export type SearchUnavailable = (typeof SEARCH_UNAVAILABLE)[keyof typeof SEARCH_UNAVAILABLE];

/**
 * What the tool takes (12-wire-contracts.md: `search_signposts(query,
 * paths?, limit? = 5)`). Declared as a schema rather than a type because the
 * MCP client is given the JSON Schema derived from it and validates against
 * the same thing the server does.
 */
export const searchInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe("What you want to know, in the words you would ask a teammate. Matched by meaning, not keyword."),
  paths: z
    .array(z.string())
    .optional()
    .describe("Repo-relative paths you are working in. A signpost scoped to one of them is ranked higher."),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`How many signposts to return. Defaults to ${DEFAULT_SEARCH_LIMIT}.`),
});

export type SearchToolInput = z.infer<typeof searchInputSchema>;

/**
 * One hit, in 12-wire-contracts.md's shape. `score` is the fused rank score.
 *
 * `category` is a plain string rather than ../signpost/schema.ts's enum, even
 * though every row was written through that enum: the SDK validates
 * `structuredContent` against this schema, so a stricter type here would turn
 * one unexpected row in a database this process only reads into a thrown tool
 * call — the one thing this server must never do.
 */
export const signpostHitSchema = z.object({
  id: z.string(),
  claim: z.string(),
  category: z.string(),
  evidence: z.string(),
  confidence: z.number(),
  score: z.number(),
});

export type SignpostHit = z.infer<typeof signpostHitSchema>;

export const searchOutputSchema = z.object({
  results: z.array(signpostHitSchema),
  /**
   * Present whenever `results` is empty, and beside results that came from a
   * degraded search. An empty result with no explanation reads as "this repo
   * has recorded nothing", and a keyword-only one reads as the best the corpus
   * has — both wrong conclusions.
   */
  diagnostic: z.string().optional(),
});

export type SearchToolOutput = z.infer<typeof searchOutputSchema>;

/** Where to send the reader when the index cannot answer: the files themselves. */
const FALLBACK = `Read ${SIGNPOSTS_DIRNAME}/${INDEX_FILENAME} and grep ${SIGNPOSTS_DIRNAME}/ directly — the signposts are markdown in this repo and are readable without this tool.`;

const REBUILD = "`signpost index` rebuilds it, and the session-start hook rebuilds it on its own in the background.";

/** Each reason's own sentence. FALLBACK is added once, after all of them. */
const REASONS: Readonly<Record<SearchUnavailable, string>> = {
  [SEARCH_UNAVAILABLE.no_repo]:
    "No search index: signposts are keyed by the repository's 'origin' remote and this checkout has none.",
  [SEARCH_UNAVAILABLE.no_index]:
    `No search index has been built in this checkout yet — expected on a fresh clone, and not an error. ${REBUILD}`,
  [SEARCH_UNAVAILABLE.not_indexed]:
    `This repo has a signposts database but no search index yet: \`signpost init\` creates the one and not the other. ${REBUILD}`,
  [SEARCH_UNAVAILABLE.unreadable]:
    `The search index could not be read at the schema this build expects. ${REBUILD}`,
  [SEARCH_UNAVAILABLE.no_match]:
    "The index was searched and no recorded signpost is close to this query.",
  [SEARCH_UNAVAILABLE.stale_index]:
    `The search index is behind the recorded signposts, so these results can miss one recorded or changed since it was built. ${REBUILD}`,
  [SEARCH_UNAVAILABLE.model_changed]:
    `The search index was built with a different embedding model, so this query was matched by keyword only, not by meaning. ${REBUILD}`,
  [SEARCH_UNAVAILABLE.no_embedder]:
    "The embedding model is not available locally, so this query was matched by keyword only, not by meaning. `signpost doctor` reports the model cache.",
};

function diagnosticOf(reasons: readonly SearchUnavailable[]): string {
  return [...reasons.map((reason) => REASONS[reason]), FALLBACK].join(" ");
}

export function diagnosticFor(reason: SearchUnavailable): string {
  return diagnosticOf([reason]);
}

/** An empty result carrying the reason — the only shape an unhappy path takes. */
export function unavailableOutput(reason: SearchUnavailable): SearchToolOutput {
  return { results: [], diagnostic: diagnosticFor(reason) };
}

/**
 * Hits as they came back, with a diagnostic when the search was degraded or
 * found nothing: an empty list is a result about the corpus and deserves the
 * same explanation the other empty results get, and `caveats` say what the
 * search could not do on the way to the hits it did find.
 */
export function searchOutput(
  hits: readonly SignpostHit[],
  caveats: readonly SearchUnavailable[] = [],
): SearchToolOutput {
  const reasons = hits.length === 0 ? [...caveats, SEARCH_UNAVAILABLE.no_match] : caveats;
  const results = [...hits];
  return reasons.length === 0 ? { results } : { results, diagnostic: diagnosticOf(reasons) };
}

/**
 * The text block that accompanies the structured result.
 *
 * Both are sent: `structuredContent` is what a client parses, and the text is
 * what a model reads when the client shows it the content blocks instead. A
 * diagnostic that only existed in the structured half would be invisible to
 * exactly the reader it is written for.
 */
export function renderOutput(output: SearchToolOutput): string {
  if (output.results.length === 0) {
    return output.diagnostic ?? diagnosticFor(SEARCH_UNAVAILABLE.no_match);
  }
  const hits = output.results.map(renderHit);
  return [...hits, ...(output.diagnostic === undefined ? [] : [output.diagnostic])].join("\n\n");
}

function renderHit(hit: SignpostHit): string {
  return `${hit.id} (${hit.category}, confidence ${hit.confidence})\n${hit.claim}\n${hit.evidence}`;
}
