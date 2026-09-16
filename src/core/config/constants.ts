// Every signposts tunable, transcribed from 13-constants.md. One named
// export per row in that document's `Name` column, byte-identical.
//
// This is the module `eslint-rules/no-magic-literal.js` looks for: no
// other file under src/ may repeat one of these literal values inline.
// Re-tuning a constant (several are judgement calls, expected to move once
// extraction quality is measured) must stay a one-line change here.

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/** LTS floor. Declared in `engines`; `doctor` checks the running version against it. */
export const NODE_MIN_VERSION = 24;

/**
 * Descriptive, not enforced by a single check (unlike NODE_MIN_VERSION and
 * SQLITE_BINDING) — recorded here anyway so every Name in 13-constants.md's
 * tables has a corresponding export.
 */
export const LANGUAGE = "TypeScript, ESM, strict";

/**
 * One binding. `node:sqlite` would drop a native dep, but the LangGraph
 * checkpointer pulls `better-sqlite3` in transitively anyway.
 */
export const SQLITE_BINDING = "better-sqlite3";

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/** Load-bearing: sessions are resumable, lower means extracting from unfinished work. */
export const IDLE_HOURS = 24;

export const MAX_AGE_DAYS = 90;

export const MAX_TRANSCRIPT_BYTES = 50_000_000;

export const MIN_GUTTERED_TOKENS = 100;

// ---------------------------------------------------------------------------
// Gutter
// ---------------------------------------------------------------------------

/** Context for what the human reacted to — not content. */
export const ASSISTANT_HEAD_CHARS = 400;

/** Whichever limit hits first alongside ASSISTANT_HEAD_CHARS. */
export const ASSISTANT_HEAD_SENTENCES = 2;

/** Head budget for the turn immediately preceding a human turn. */
export const ASSISTANT_HEAD_CHARS_ADJACENT = 600;

/** Tail budget for the same turn — a plan's conclusion is what gets accepted or rejected. */
export const ASSISTANT_TAIL_CHARS_ADJACENT = 900;

/** Content block types in a Claude Code transcript — named to avoid magic literals. */
export const TEXT_BLOCK_TYPE = "text";
export const TOOL_USE_BLOCK_TYPE = "tool_use";
export const TOOL_RESULT_BLOCK_TYPE = "tool_result";

/** Slash-command noise arriving as user text. */
export const STRIP_TAGS = [
  "command-name",
  "command-message",
  "command-args",
  "local-command-stdout",
  "local-command-caveat",
  "system-reminder",
] as const;

/** Sanity check, not enforced. Far outside this range → parser bug. */
export const TARGET_REDUCTION = { min: 10, max: 20 } as const;

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

export const ENTROPY_MIN_LEN = 32;

export const SECRET_KEY_NAME_RE = /(SECRET|TOKEN|PASSWORD|PASSWD|KEY|CREDENTIAL|API[_-]?KEY)/i;

export const TOKEN_PREFIXES = [
  "sk-",
  "sk-ant-",
  "ghp_",
  "github_pat_",
  "gho_",
  "AKIA",
  "ASIA",
  "xox[baprs]-",
  "AIza",
  "glpat-",
  "dop_v1_",
] as const;

export const PLACEHOLDER_FORMAT = "[REDACTED:<kind>]";

/** Redactor throws → skip transcript. Never fall through to raw text. */
export const FAIL_MODE = "closed";

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

/** Judgement; doc-noted range 5–8. */
export const NEIGHBOUR_K = 6;

/** Standard constant for reciprocal rank fusion. */
export const RRF_K = 60;

/**
 * What the lexical (FTS/BM25) list contributes to the fusion, relative to the
 * vector list's 1 (19-value-to-a-user.md item 9).
 *
 * The two halves are not equally informative about the question this product
 * asks. The vector list answers "does this mean the same thing"; the lexical
 * list is there for the tokens an embedding is bad at — an env var name, a file
 * path, an error string. At equal weight it instead decided ordinary
 * conversational queries on shared words like "environment" and "changes", and
 * that is the mechanism behind item 7.
 *
 * **Swept against test/eval/retrieval-recall.test.ts, 2026-09-16.** recall@5 is
 * 1.000 at every weight; MRR is what moves:
 *
 *   1.0  0.939      0.3  0.944
 *   0.6  0.944      0.2  0.951
 *   0.4  0.944      0.1  0.972      0  0.972
 *
 * Read that honestly: on this eval the lexical half only ever costs accuracy,
 * and the best-scoring setting is to switch it off. It is not switched off,
 * and the reason is that the eval cannot see the case the half exists for.
 * Its four rare-identifier queries (.nvmrc, allkeys-lru, SameSite=Lax,
 * reset-dev-db.sh) are all answered by the vector list alone, because every one
 * of those tokens is in the claim text the embedder saw. The case that needs
 * BM25 — a token in a query that appears in no claim this corpus holds, or one
 * the tokenizer shreds — is a case forty hand-written signposts do not contain.
 * Deleting half of 05-retrieval.md's hybrid design on that evidence would be
 * the same mistake in the other direction.
 *
 * So: 0.2, the lowest weight at which the lexical list still changes the
 * outcome at all. Below it the fusion is the vector list with rounding. A
 * corpus with real rare-token queries in it is what would settle this
 * properly, and that is the eval's next piece of work rather than this
 * constant's.
 */
export const FTS_RRF_WEIGHT = 0.2;

/**
 * Weight applied to pathOverlapBoost's boolean signal before adding it to
 * the fused RRF score. Sized to close a realistic few-rank gap but not a large
 * one — one shared path can promote a near-peer, not overturn a much stronger
 * match.
 *
 * The gaps, at RRF_K=60 with the lexical list at FTS_RRF_WEIGHT 0.2: rank 1 in
 * both lists scores ~0.0197; rank 1 vs rank 2 in both is ~0.00032, which the
 * boost closes; rank 1 vs rank 6 in both is ~0.0015, which it does not. These
 * were ~0.0005 and ~0.0025 under equal weights. The weighting narrowed both
 * margins without moving either across 0.001, so the value stands; re-derive
 * them if FTS_RRF_WEIGHT moves.
 */
export const PATH_OVERLAP_BOOST_WEIGHT = 0.001;

/**
 * Pinned revision. A bare repo id is mutable, and unchanged-id-changed-weights
 * defeats the rebuild trigger.
 *
 * ASSUMPTION: 13-constants.md leaves the revision as `<revision>`. Pinned
 * here to a Xenova/all-MiniLM-L6-v2 commit confirmed to exist via
 * `GET https://huggingface.co/api/models/Xenova/all-MiniLM-L6-v2/revision/<sha>`
 * (200) at the time this was written. Reconfirm against the Hub before
 * relying on it in production — models and their branches can move.
 */
export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2@751bff37182d3f1213fa05d7196b954e230abad9";

/** Must match model. */
export const EMBEDDING_DIM = 384;

/** Set `false` with LOCAL_MODEL_PATH for networks with no route to the Hub. */
export const ALLOW_REMOTE_MODELS = true;

/**
 * Deliberately absent **on the write path**. No neighbours → `classify` sees an
 * empty list → `NOVEL`. Never pad `k` to manufacture a minimum-similarity floor.
 *
 * The read path is the opposite case and has its own floor below.
 */
export const MIN_SIMILARITY = undefined;

/**
 * Cosine floor a signpost's claim has to clear against the query before the
 * read path will return it (19-value-to-a-user.md item 8).
 *
 * MIN_SIMILARITY above is right about the write path and wrong about this one.
 * There, no neighbour is a fact `classify` needs — it means `NOVEL`. Here, a
 * row nothing matched is a wrong answer handed to a model with nothing marking
 * it as one: the question "how do I make a sourdough starter rise faster" came
 * back with five signposts about CDN purges and Kubernetes limits, and
 * `no_match` fired only on a literally empty corpus.
 *
 * **Measured against test/eval/retrieval-recall.test.ts, 2026-09-16.** Over
 * that corpus the closest any of the four unanswerable questions gets to a
 * signpost is 0.225 (sourdough), and the furthest any real answer sits from
 * its question is 0.311 (staging-db-read-only, for "is it safe to apply schema
 * changes to the pre-production environment"). 0.27 is the midpoint, about
 * 0.04 from each edge. Swept, the eval holds 4/4 no-match and 24/24 recall at
 * 0.25 and 0.3 only; 0.2 lets sourdough back in, 0.35 loses the staging
 * question.
 *
 * That margin is narrow and it is one corpus of forty hand-written claims.
 * Treat this as the first measured value, not a settled one: a real repo's
 * corpus is what will say whether the gap holds.
 */
export const READ_MIN_SIMILARITY = 0.27;

/**
 * How many candidates each retriever is asked for before fusion, whatever limit
 * the caller wants — unless the caller wants more than this, in which case the
 * pool is the limit (19-value-to-a-user.md item 9).
 *
 * `k` used to be both the pool and the page size: the vector KNN and the FTS
 * LIMIT each got the caller's `k`, the two lists were fused, and the fusion was
 * sliced back to `k`. RRF over two truncated lists depends on where they were
 * truncated, so the order moved when the limit did. Over
 * test/eval/retrieval-recall.test.ts that reshuffled ranks 2-5 on most of the
 * write-path queries between k=5 and k=20 while leaving rank 1 alone — which is
 * why MRR never saw it, and why it matters anyway: ranks 2-5 are what
 * `classify` is shown.
 *
 * A fixed pool rather than a multiple of `k`, because a multiple is still a
 * function of `k`. Measured: a pool of 8k left the same query ranking
 * differently at limit 1 and limit 5. A constant pool makes every limit up to it
 * a prefix of the same ranking, by construction rather than by luck.
 *
 * 50 covers NEIGHBOUR_K and the MCP default with a wide margin. Both retrievers
 * are indexed, so the cost of asking for 50 is small next to the embedding
 * call the query already paid for.
 */
export const RETRIEVAL_POOL = 50;

/** Conditions that trigger a reindex. */
export const REINDEX_TRIGGER = [
  "content-hash-mismatch",
  "missing-index",
  "model-change",
] as const;

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

/** Bounds the reflection loop. */
export const MAX_EXTRACT_ATTEMPTS = 2;

/** Bounds self-correction. */
export const MAX_VALIDATE_ATTEMPTS = 2;

/** Above this ratio of critic rejections → retry extraction. Judgement; tune by measuring extraction quality. */
export const CRITIC_REJECT_RATIO = 0.66;

/** Unrecognised → discard thread, re-run from transcript. */
export const STATE_VERSION = 1;

/** Backstop against runaway extraction. */
export const MAX_CANDIDATES_PER_SESSION = 10;

// ---------------------------------------------------------------------------
// Review gate
// ---------------------------------------------------------------------------

/** Saddle. The main knob to calibrate against measured extraction quality. */
export const AUTO_PUBLISH_CONFIDENCE = 0.85;

/**
 * Ceiling when the human hedged. Below AUTO_PUBLISH_CONFIDENCE by
 * construction, so hedged claims can never auto-land. Judgement.
 */
export const HEDGE_CONFIDENCE_CAP = 0.6;

/** Not configurable — anything altering approved knowledge. */
export const ALWAYS_HUMAN_OPS = ["refine", "supersede", "retire"] as const;

/**
 * Older → drop with a log line. Only `signpost review` drops one, with the
 * developer at the terminal; a background reader leaves it where it is
 * (19-value-to-a-user.md item 3).
 */
export const THREAD_EXPIRY_DAYS = 30;

/**
 * How close to THREAD_EXPIRY_DAYS a parked review has to be before the status
 * line, the session-start notice and `signpost review` say how long it has
 * left. A week, so a developer who opens Claude Code most working days sees it
 * several times before it goes. Transcribed in hooks/session-start.ts and
 * statusline/statusline.ts.
 */
export const REVIEW_EXPIRY_WARN_DAYS = 7;

/** Not configurable. See 06-review-and-pr.md. */
export const AUTO_MERGE = false;

// ---------------------------------------------------------------------------
// Bootstrap (first run in a repo)
// ---------------------------------------------------------------------------

/** Replaces MAX_AGE_DAYS on the first run only. */
export const BOOTSTRAP_AGE_DAYS = 14;

/** Hard cap per run — MAX_CANDIDATES_PER_SESSION bounds a session, not a run. */
export const BOOTSTRAP_MAX_OPS = 20;

/** Every operation routes to a human, whatever its confidence. */
export const BOOTSTRAP_GATE_ALL = true;

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

/**
 * Per developer, not per repo — a shared branch produces push races between
 * teammates' workers — and per review cycle rather than for ever: `{date}`
 * turns over once the branch's pull request has merged, because a branch
 * reused past its own merge never picks the base branch back up again
 * (src/core/git/branch.ts).
 */
export const BRANCH_PATTERN = "signposts/{author_slug}/{date}";

/**
 * How many of the repo's pull requests are read to find which of this
 * developer's branches are under review, and which names are already spent.
 * One page: the names being guarded against carry this week's date, and every
 * pull request in the repo's history is a slow call for the same answer.
 */
export const FORGE_BRANCH_PAGE = 100;

/** Local-part of `git config user.email`, kebab-cased. Real identity — the branch lives in the team's own repo. */
export const AUTHOR_SLUG = "local-part of git config user.email, kebab-cased";

/** Prompts and local DB only. Never written to `.signposts/`. */
export const AUTHOR_PSEUDONYM = "author-<sha256(email + repoRoot)[:4]>";

/**
 * AUTHOR_PSEUDONYM's prefix as a value rather than as prose — what
 * src/core/redact/patterns.ts builds a pseudonym from. Per repo rather than
 * per session (02-ingestion.md) so the same person is recognisably the same
 * person across sessions, which is the whole reason the model can follow a
 * conversation between two of them.
 *
 * The `[:4]` half deliberately stays out of this module: exporting the number
 * 4 would make every unrelated literal 4 under src/ a no-magic-literal error,
 * which is a poor trade for one slice length. It lives beside its only use.
 */
export const AUTHOR_PSEUDONYM_PREFIX = "author-";

// ---------------------------------------------------------------------------
// Claim validation
// ---------------------------------------------------------------------------

export const CLAIM_MAX_CHARS = 200;

export const CLAIM_ALLOW_NEWLINE = false;

/** Two claims smuggled into one. */
export const CLAIM_REJECT_SUBSTRINGS = [" and also ", "; additionally"] as const;

export const EVIDENCE_MAX_CHARS = 500;

export const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Longest id `generateSlug` will mint, before any collision suffix.
 *
 * An id is a filename (`.signposts/<category>/<id>.md`) and a table cell in
 * the index, and 03-memory-model.md asks for "a stable slug, e.g.
 * staging-db-read-only". Uncapped, the slug was the entire claim: a real run
 * produced a 164-character filename against a 255-byte component limit, so a
 * longer claim would have failed the write outright.
 */
export const MAX_SLUG_LENGTH = 48;

/** Indent for JSON written to disk, so a fixture diff is readable line by line. */
export const JSON_INDENT = 2;

/** How much of a bad reply to quote in an error before it stops helping. */
export const ERROR_EXCERPT_CHARS = 300;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Global, home-relative — Claude Code's config directory, absent an override. */
export const CLAUDE_CONFIG_ROOT = "~/.claude";

/** The subdirectory of the Claude Code config directory holding transcripts. */
export const TRANSCRIPT_DIRNAME = "projects";

/**
 * Directory name used both for the global root under the home directory
 * (`~/.signposts/`) and for the per-repo knowledge directory
 * (`<repoRoot>/.signposts/`) — same literal, two different parents.
 */
export const SIGNPOSTS_DIRNAME = ".signposts";

/** Global, NOT under STATE_DIR — see MODEL_CACHE_DIR in 13-constants.md. */
export const MODEL_CACHE_DIRNAME = "models";

export const DB_FILENAME = "signposts.db";

/**
 * Per-repo state subdirectory holding the git worktree a run commits through.
 *
 * Proposals are never written into the checkout the developer is working in:
 * a run happens while they are mid-task, and switching their branch or
 * dropping files into their working tree to open a PR is the tool taking
 * their editor hostage. The worktree is a second checkout of the same
 * repository, on the signposts branch, which nothing else touches.
 */
export const WORKTREE_DIRNAME = "pr-worktree";

export const CHECKPOINT_FILENAME = "checkpoints.db";

export const STATUSLINE_FILENAME = "status.json";

export const LOCKFILE_FILENAME = "run.lock";

export const INDEX_FILENAME = "index.md";

// ---------------------------------------------------------------------------
// Triggering
// ---------------------------------------------------------------------------

/** Hard target. `SessionStart` is synchronous — exceeding this delays the user. */
export const HOOK_BUDGET_MS = 50;

/** Older lock → assume dead worker, take over. */
export const LOCK_STALE_MINUTES = 60;

/** Worker writes state at most this often. */
export const STATUSLINE_REFRESH_MS = 1000;

/** The same cadence as `statusLine.refreshInterval` takes it: whole seconds. */
export const STATUSLINE_REFRESH_SECONDS = STATUSLINE_REFRESH_MS / 1000;

/**
 * How long a run's progress stays believable without being touched.
 *
 * Progress is stamped by whatever invocation last moved it, and a run is a
 * sequence of separate processes: nothing runs a cleanup when the developer
 * closes the terminal between two halts. Past this, the statusLine stops
 * rendering it and the next run starts its count from zero rather than
 * continuing someone else's abandoned one.
 */
export const RUN_PROGRESS_STALE_MINUTES = 15;

