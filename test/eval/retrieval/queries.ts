// The labelled query set for the retrieval eval (19-value-to-a-user.md, Phase 1).
//
// Two shapes, because the product has two callers and they do not send the same
// kind of text:
//
// - `claim` queries are what `findNeighbours` receives on the write path — a
//   candidate signpost's claim, checked against the corpus for a duplicate or a
//   contradiction. They are written as assertions, worded differently from the
//   entry they should find.
// - `question` queries are what `search_signposts` receives on the read path —
//   a person or a model asking something in ordinary language, usually with
//   none of the corpus's vocabulary in it.
//
// Four queries are labelled relevant to nothing. They are the only thing that
// can catch item 8: without a floor on the read path the ranker returns five
// confident-looking rows for a question about sourdough, and `no_match` fires
// only on an empty corpus.
//
// Relevance is binary and hand-assigned. Graded relevance was considered and
// dropped with nDCG — it needs a second judgement over every query/document
// pair and there is no decision here it would change.

export type QueryShape = "claim" | "question";

export interface EvalQuery {
  id: string;
  shape: QueryShape;
  text: string;
  /** Corpus ids that answer this query. Empty means nothing in the corpus does. */
  relevant: readonly string[];
}

export const EVAL_QUERIES: readonly EvalQuery[] = [
  // --- candidate claims, as the write path sees them -----------------------
  {
    id: "claim-staging-migrations",
    shape: "claim",
    text: "Schema migrations must not be applied to the staging database; point them at dev.",
    relevant: ["staging-db-read-only"],
  },
  {
    id: "claim-credentials-location",
    shape: "claim",
    text: "Credentials belong in the shared password vault rather than a checked-in dotenv file.",
    relevant: ["secrets-in-1password"],
  },
  {
    id: "claim-prisma-location",
    shape: "claim",
    text: "Keep the Prisma schema file under the prisma directory, or generation quietly does nothing.",
    relevant: ["prisma-schema-path"],
  },
  {
    id: "claim-idempotent-consumers",
    shape: "claim",
    text: "Consumers have to tolerate the same message being delivered more than once.",
    relevant: ["sqs-is-at-least-once"],
  },
  {
    id: "claim-app-directory",
    shape: "claim",
    text: "Do not add new routes under the pages directory; the app directory is where they go now.",
    relevant: ["next-app-router-only"],
  },
  {
    id: "claim-package-manager",
    shape: "claim",
    text: "Installing dependencies with npm here corrupts the lockfile and the pipeline rejects it.",
    relevant: ["pnpm-not-npm"],
  },
  {
    id: "claim-trust-request-user",
    shape: "claim",
    text: "A route handler can rely on the authenticated user already being attached to the request.",
    relevant: ["jwt-verified-at-edge"],
  },
  {
    id: "claim-json-logging",
    shape: "claim",
    text: "Emit logs as JSON objects, because plain text lines never reach the log store.",
    relevant: ["logs-must-be-structured-json"],
  },
  {
    id: "claim-api-version-header",
    shape: "claim",
    text: "Clients select which API version they want through a request header.",
    relevant: ["api-versioned-by-header"],
  },
  {
    id: "claim-pr-title-is-history",
    shape: "claim",
    text: "The merge strategy throws away the individual commits, so the pull request title becomes the history.",
    relevant: ["squash-merge-only"],
  },
  {
    id: "claim-utc-storage",
    shape: "claim",
    text: "Store every time in UTC and convert it only when it is displayed.",
    relevant: ["timestamps-stored-in-utc"],
  },
  {
    id: "claim-remote-terraform-state",
    shape: "claim",
    text: "Terraform must never be applied from a state file on someone's laptop.",
    relevant: ["terraform-state-in-s3"],
  },

  // --- natural questions, as the MCP server sees them ----------------------
  {
    // 05-retrieval.md's first acceptance criterion, and item 7 of
    // 19-value-to-a-user.md: the near-miss that contradicts the right answer
    // is `staging-warehouse-writable`, and it used to outrank this.
    id: "question-staging-schema-change",
    shape: "question",
    text: "is it safe to apply schema changes to the pre-production environment",
    relevant: ["staging-db-read-only"],
  },
  {
    id: "question-where-is-db-password",
    shape: "question",
    text: "where do I find the database password for the payments service",
    relevant: ["secrets-in-1password"],
  },
  {
    id: "question-flag-does-nothing",
    shape: "question",
    text: "why is my new feature flag not doing anything in staging",
    relevant: ["feature-flag-default-off"],
  },
  {
    id: "question-cdn-propagation",
    shape: "question",
    text: "how long after purging does the CDN actually start serving the new file",
    relevant: ["cdn-purge-is-async"],
  },
  {
    id: "question-jobs-in-redis",
    shape: "question",
    text: "can I keep background jobs in redis until a worker picks them up",
    relevant: ["redis-is-allkeys-lru"],
  },
  {
    id: "question-slow-first-request",
    shape: "question",
    text: "why does the very first request each morning take so long",
    relevant: ["staging-cluster-scales-to-zero"],
  },
  {
    id: "question-push-rejected",
    shape: "question",
    text: "my push was rejected by a branch protection rule and I do not know which one",
    relevant: ["commits-must-be-gpg-signed"],
  },
  {
    id: "question-remove-api-field",
    shape: "question",
    text: "what is the process for removing a field from the public API",
    relevant: ["breaking-change-over-two-releases"],
  },

  // --- relevant to nothing -------------------------------------------------
  {
    id: "none-sourdough",
    shape: "question",
    text: "how do I make a sourdough starter rise faster",
    relevant: [],
  },
  {
    id: "none-marathon",
    shape: "question",
    text: "what is the best way to train for a marathon in humid weather",
    relevant: [],
  },
  {
    id: "none-houseplants",
    shape: "question",
    text: "which houseplants survive in a north facing window",
    relevant: [],
  },
  {
    id: "none-guitar",
    shape: "question",
    text: "how do I tune a guitar to drop D",
    relevant: [],
  },
];

export const RELEVANT_QUERIES = EVAL_QUERIES.filter((q) => q.relevant.length > 0);
export const NO_MATCH_QUERIES = EVAL_QUERIES.filter((q) => q.relevant.length === 0);
