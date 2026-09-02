// Every signposts tunable, transcribed from 13-constants.md. One named
// export per row in that document's `Name` column, byte-identical.
//
// This is the module `eslint-rules/no-magic-literal.js` looks for: no
// other file under src/ may repeat one of these literal values inline.
// Re-tuning a constant (the golden set is expected to re-tune several)
// must stay a one-line change here.

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

/** Wire-format tags for content block types — not tunables, just named to avoid magic literals. */
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
 * Weight applied to pathOverlapBoost's boolean signal before adding it to
 * the fused RRF score (RRF_K=60 → per-list scores ~0.008-0.016, ~0.033 max for
 * rank 1 in both lists). Sized to close a realistic few-rank gap (e.g. rank
 * 1 vs rank 2 in both lists is ~0.0005) but not a large one (rank 1 vs rank
 * 6 in both lists is ~0.0025) — one shared path can promote a near-peer,
 * not overturn a much stronger match.
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
 * Deliberately absent. No neighbours → `classify` sees an empty list →
 * `NOVEL`. Never pad `k` to manufacture a minimum-similarity floor.
 */
export const MIN_SIMILARITY = undefined;

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

/** Above this ratio of critic rejections → retry extraction. Judgement; tune with golden set. */
export const CRITIC_REJECT_RATIO = 0.66;

/** Phase 4.5. */
export const MAX_RESOLVE_TOOL_ITERATIONS = 6;

/** Unrecognised → discard thread, re-run from transcript. */
export const STATE_VERSION = 1;

/** Backstop against runaway extraction. */
export const MAX_CANDIDATES_PER_SESSION = 10;

// ---------------------------------------------------------------------------
// Review gate
// ---------------------------------------------------------------------------

/** Saddle. Primary knob the golden set should calibrate. */
export const AUTO_PUBLISH_CONFIDENCE = 0.85;

/**
 * Ceiling when the human hedged. Below AUTO_PUBLISH_CONFIDENCE by
 * construction, so hedged claims can never auto-land. Judgement.
 */
export const HEDGE_CONFIDENCE_CAP = 0.6;

/** Not configurable — anything altering approved knowledge. */
export const ALWAYS_HUMAN_OPS = ["refine", "supersede", "retire"] as const;

/** Older → drop with a log line. */
export const THREAD_EXPIRY_DAYS = 30;

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

/** Per developer, not per repo. A shared branch produces push races between teammates' workers. */
export const BRANCH_PATTERN = "signposts/{author_slug}";

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

// ---------------------------------------------------------------------------
// Models and cost
// ---------------------------------------------------------------------------

/**
 * The model a node uses unless config names another, and the fallback for any
 * node without its own constant below.
 */
export const MODEL_DEFAULT = "claude-opus-5";

/**
 * Per-node models (08-models-and-credentials.md, "Candidate step-down").
 *
 * `extract` carries the largest input and `classify` the highest call count,
 * so they are where a cheaper model pays. `critic` and `resolve_conflict` stay
 * on MODEL_DEFAULT deliberately: the doc's line on them is "never economise
 * here" and "cost is irrelevant" — they are low-volume and the hardest
 * judgment in the graph.
 *
 * The doc calls the classify step-down "genuinely uncertain: the hard case is
 * duplicate-vs-contradiction, exactly where a small model may fold". Nothing
 * currently measures that; see the note on the golden replay suite.
 */
export const MODEL_EXTRACT = "claude-sonnet-5";
export const MODEL_CLASSIFY = "claude-haiku-4-5";

/** `true` for background runs, `false` for `--sync`. */
export const BATCH_BY_DEFAULT = true;

/**
 * Minimum cacheable prefix, per model. A system prompt shorter than its
 * model's entry does not cache: the `cache_control` marker is silently
 * ignored and `cache_creation_input_tokens` comes back 0, with no error.
 *
 * One number per model, not one number (13-constants.md,
 * "PROMPT_CACHE_MIN_TOKENS is per model"): the minimum does not fall as the
 * models get newer, and Haiku 4.5 needs eight times what Opus 5 needs.
 *
 * PROMPT_CACHE_MIN_TOKENS_FALLBACK is the largest published minimum, used for
 * a model absent from the map: assuming a short prompt will not cache costs a
 * cache entry, assuming it will costs a false acceptance criterion.
 */
export const PROMPT_CACHE_MIN_TOKENS: Readonly<Record<string, number>> = {
  "claude-opus-5": 512,
  "claude-sonnet-5": 1024,
  "claude-haiku-4-5": 4096,
};

export const PROMPT_CACHE_MIN_TOKENS_FALLBACK = 4096;

/**
 * Thinking is on by default on every model `extract` runs on and shares this
 * budget with the reply. 8000 was enough for Opus but truncated Sonnet 5
 * mid-JSON on the two largest golden transcripts (009, 025), which surfaces
 * as a parse error rather than as the token cap it is.
 */
export const MAX_TOKENS_EXTRACT = 16000;

/** critic, classify. */
export const MAX_TOKENS_SMALL = 2000;

/**
 * resolve_conflict. Larger than the other two small nodes because it is the
 * only one that reasons about two competing claims and can return two scopes
 * with it, and because thinking shares the budget. At MAX_TOKENS_SMALL it
 * truncated mid-JSON on the first genuine contradiction the scenarios reached.
 */
export const MAX_TOKENS_RESOLVE = 8000;

/** Log a warning above this. */
export const COST_WARN_PER_RUN_USD = 1.0;

/**
 * List price in USD per million tokens, by model id
 * (08-models-and-credentials.md). Nodes can each run a different model, so a
 * single pair of numbers would misreport every call that is not Opus.
 *
 * Anything absent here cannot be priced, and signposts refuses to guess:
 * costUsd is written into every fixture and usage record, and a number that
 * is silently wrong is worse than a missing one. The refusal happens when the
 * provider is constructed, before any request is sent — see modelPrices() in
 * src/io/model/anthropic-provider.ts.
 *
 * Sonnet 5's $2/$10 launched as introductory pricing through 2026-08-31. It
 * is the standard price now: Anthropic cancelled the increase to $3/$15 that
 * was scheduled for 2026-09-01, so these numbers need no expiry handling.
 */
export const MODEL_PRICES: Readonly<Record<string, { input: number; output: number }>> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/** Cache reads bill at ~0.1x input; writing a cache entry costs ~1.25x. */
export const PRICE_CACHE_READ_MULTIPLIER = 0.1;
export const PRICE_CACHE_WRITE_MULTIPLIER = 1.25;

export const TOKENS_PER_MTOK = 1_000_000;

/** Indent for JSON written to disk, so a fixture diff is readable line by line. */
export const JSON_INDENT = 2;

/** How much of a bad reply to quote in an error before it stops helping. */
export const ERROR_EXCERPT_CHARS = 300;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Global, home-relative — where Claude Code writes session transcripts. */
export const TRANSCRIPT_ROOT = "~/.claude/projects";

/**
 * Directory name used both for the global root under the home directory
 * (`~/.signposts/`) and for the per-repo knowledge directory
 * (`<repoRoot>/.signposts/`) — same literal, two different parents.
 */
export const SIGNPOSTS_DIRNAME = ".signposts";

/** Global, NOT under STATE_DIR — see MODEL_CACHE_DIR in 13-constants.md. */
export const MODEL_CACHE_DIRNAME = "models";

export const DB_FILENAME = "signposts.db";

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

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * Every Anthropic auth method signposts accepts, highest priority first —
 * the order `auth.method: auto` walks. The Claude subscription leads
 * deliberately: it is the zero-configuration path, so a developer who has
 * only ever signed in to Claude Code can run signposts without creating a
 * console account. See 08-models-and-credentials.md.
 */
export const AUTH_CHAIN = [
  "claude-subscription",
  "api-key",
  "auth-token",
  "console-profile",
] as const;

/**
 * `auth.method`'s default: walk AUTH_CHAIN. Any other value pins one method.
 * Spelled "auto-detect" rather than "auto" so it stays distinct from the
 * review gate's unrelated "auto" verdict (src/core/gate/gate.ts).
 */
export const AUTH_METHOD_AUTO = "auto-detect";

/** macOS Keychain generic-password service Claude Code stores its OAuth credential under. */
export const CLAUDE_CODE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/** Key wrapping the credential inside that Keychain item's JSON payload. */
export const CLAUDE_CODE_OAUTH_KEY = "claudeAiOauth";

/** Non-macOS home-relative fallback for the same credential. */
export const CLAUDE_CODE_CREDENTIALS_FILE = ".claude/.credentials.json";

/** Home-relative `ant auth login` config dir, used when ANTHROPIC_CONFIG_DIR is unset. */
export const ANTHROPIC_CONFIG_DIRNAME = ".config/anthropic";

/** Subdirectory of the config dir holding one JSON file per logged-in profile. */
export const ANTHROPIC_CREDENTIALS_DIRNAME = "credentials";

/** Profile consulted when ANTHROPIC_PROFILE is unset. */
export const ANTHROPIC_DEFAULT_PROFILE = "default";

/**
 * Treat an access token as expired this long before its stated expiry, so a
 * token that dies mid-run is caught before the request rather than during it.
 */
export const TOKEN_EXPIRY_SKEW_MS = 60_000;

/**
 * Subscription rate-limit tier that shares quota with interactive Claude Code
 * use. Seeing this means a background signposts run competes with the
 * developer's own session — 08-models-and-credentials.md's first objection.
 */
export const SHARED_QUOTA_TIER = "default_claude_ai";
