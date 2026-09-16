// The synthetic corpus the retrieval eval ranks over (19-value-to-a-user.md,
// Phase 1). One fictional repo, forty signposts, written by hand.
//
// Forty is not a round number picked for looks. The three retrieval tests that
// existed before this file each ran a two-document corpus with a limit of five
// or six, so every document came back for every query and a `toContain`
// assertion could not fail on ranking. Position only becomes falsifiable when
// the corpus is several times the limit.
//
// About fifteen of these are deliberate near-misses: same subject as another
// entry, different claim, and in a few cases the opposite claim. 05-retrieval.md's
// own worked example is the template — read-only staging next to the writable
// ETL replica — because that is the pair where getting the order wrong does
// real damage. A miss returns nothing; a near-miss ranked first hands the model
// the contradiction of the right answer.
//
// `scope.paths` is left off every row on purpose. The path-overlap boost has
// its own tests (test/behaviour/db/neighbours.test.ts), and a boost applied
// here would measure that arithmetic rather than the hybrid ranking this eval
// exists to measure.

import type { ActiveSignpost } from "../../../src/io/db/vector-index.ts";

export const EVAL_REPO = "acme/platform";

interface CorpusEntry {
  id: string;
  claim: string;
  evidence: string;
}

const ENTRIES: CorpusEntry[] = [
  // --- databases and environments -----------------------------------------
  {
    id: "staging-db-read-only",
    claim: "The staging database is read-only. Run migrations against the dev database instead.",
    evidence: "A migration run against staging failed with a permissions error.",
  },
  {
    id: "staging-warehouse-writable",
    claim: "The staging warehouse replica is writable, and the nightly ETL job truncates and reloads it.",
    evidence: "A fixture written into the replica disappeared overnight.",
  },
  {
    id: "prod-migrations-ci-only",
    claim: "Production migrations run from the CI deploy job only, never from a developer machine.",
    evidence: "A hand-run migration left the deploy job's migration history one row behind.",
  },
  {
    id: "dev-db-reset-drops-tables",
    claim: "scripts/reset-dev-db.sh drops every table before it seeds, so it is not safe to run against a database you care about.",
    evidence: "Someone pointed it at the shared dev database and lost a week of seeded accounts.",
  },

  // --- secrets -------------------------------------------------------------
  {
    id: "secrets-in-1password",
    claim: "Service credentials live in the 1Password Platform vault. They are not kept in .env files.",
    evidence: "A reviewer rejected a PR that added a real database URL to .env.local.",
  },
  {
    id: "env-example-is-placeholders",
    claim: ".env.example holds placeholder values only. Copying it verbatim gives a local app that starts and makes no external calls.",
    evidence: "A new hire spent a morning debugging auth against the placeholder client id.",
  },
  {
    id: "ci-secrets-per-environment",
    claim: "CI secrets are set per GitHub environment, not at the repository level, so a workflow without an environment sees none of them.",
    evidence: "A release workflow failed on an empty token until it declared environment: production.",
  },

  // --- prisma --------------------------------------------------------------
  {
    id: "prisma-schema-path",
    claim: "The Prisma schema belongs at prisma/schema.prisma. The generator finds nothing and exits zero if it is at schema/prisma.",
    evidence: "A generate step produced no client and reported success.",
  },
  {
    id: "prisma-migrate-not-db-push",
    claim: "Use prisma migrate dev rather than prisma db push. db push skips the migration history the deploy job replays.",
    evidence: "A column added with db push was missing in production after the next deploy.",
  },

  // --- feature flags -------------------------------------------------------
  {
    id: "feature-flag-default-off",
    claim: "A new LaunchDarkly flag is off in every environment until it is explicitly targeted, including in staging.",
    evidence: "A feature was reported broken in staging when the flag had never been turned on.",
  },
  {
    id: "feature-flag-removed-after-30-days",
    claim: "A flag fully rolled out for thirty days is deleted by the flag-debt job, and the code path behind it goes with it.",
    evidence: "A flag check still in the code started returning the default after the job ran.",
  },

  // --- caching and queues --------------------------------------------------
  {
    id: "cdn-purge-is-async",
    claim: "A Fastly purge takes up to sixty seconds to propagate. Do not assert on the purged URL straight after the call.",
    evidence: "A deploy smoke test failed intermittently on a stale asset.",
  },
  {
    id: "redis-is-allkeys-lru",
    claim: "Redis runs with allkeys-lru eviction, so nothing stored in it is durable. Never use it as a job queue.",
    evidence: "Queued jobs vanished under memory pressure during a traffic spike.",
  },
  {
    id: "sqs-is-at-least-once",
    claim: "SQS delivery is at-least-once, so every consumer has to be idempotent.",
    evidence: "A duplicate delivery charged a customer twice.",
  },

  // --- frontend ------------------------------------------------------------
  {
    id: "next-app-router-only",
    claim: "New pages go under app/. The pages/ router is kept only for the /legacy routes and takes nothing new.",
    evidence: "A page added under pages/ was rejected in review.",
  },
  {
    id: "tailwind-no-arbitrary-values",
    claim: "Arbitrary Tailwind values are rejected by the linter. Add a token to tailwind.config.ts instead.",
    evidence: "A build failed on a w-[327px] class.",
  },
  {
    id: "react-query-stale-time-is-global",
    claim: "React Query's staleTime is five minutes globally in providers.tsx, so a component that needs fresh data has to override it.",
    evidence: "A dashboard showed five-minute-old numbers after a mutation.",
  },

  // --- tests ---------------------------------------------------------------
  {
    id: "suite-runs-with-network-denied",
    claim: "The test suite has to pass with the network denied. Check it under sandbox-exec before merging anything that loads a model.",
    evidence: "The suite was green for weeks while fetching a model on every run.",
  },
  {
    id: "playwright-uses-seeded-db",
    claim: "Playwright runs against a database the global setup seeds, not against dev, so a test that depends on dev data fails in CI.",
    evidence: "A test passed locally and failed in CI on a missing account.",
  },
  {
    id: "no-snapshot-tests",
    claim: "Snapshot tests are not used here. Assert on the specific fields that matter instead.",
    evidence: "A snapshot was updated wholesale and hid a regression for two releases.",
  },

  // --- tooling -------------------------------------------------------------
  {
    id: "pnpm-not-npm",
    claim: "This repo uses pnpm. An npm install rewrites the lockfile and CI rejects the diff.",
    evidence: "A PR carried a package-lock.json nobody meant to add.",
  },
  {
    id: "node-version-from-nvmrc",
    claim: "CI reads the Node version from .nvmrc, so bumping engines in package.json alone changes nothing.",
    evidence: "A syntax error only CI saw survived an engines bump.",
  },
  {
    id: "checkout-needs-no-build",
    claim: "A checkout runs with no build step. dist/ exists only for the published package.",
    evidence: "A new hire ran a build that was not needed and then debugged the stale output.",
  },

  // --- auth ----------------------------------------------------------------
  {
    id: "jwt-verified-at-edge",
    claim: "JWTs are verified in the edge middleware, so a route handler can trust req.user without checking it again.",
    evidence: "A handler that re-verified the token added forty milliseconds to every request.",
  },
  {
    id: "session-cookie-is-samesite-lax",
    claim: "The session cookie is SameSite=Lax, so a cross-site POST never carries it.",
    evidence: "A third-party form post arrived unauthenticated.",
  },
  {
    id: "service-tokens-not-user-jwts",
    claim: "Service-to-service calls carry a signed service token. Forwarding a user's JWT between services is not allowed.",
    evidence: "A forwarded token outlived the user's session and kept working.",
  },

  // --- observability -------------------------------------------------------
  {
    id: "logs-must-be-structured-json",
    claim: "Logs have to be structured JSON. The collector drops a bare console.log line.",
    evidence: "An incident had no logs because the handler printed plain strings.",
  },
  {
    id: "traces-sampled-at-one-percent",
    claim: "Traces are sampled at one percent, so a missing trace does not mean the request failed.",
    evidence: "An hour went into chasing a request that had simply not been sampled.",
  },
  {
    id: "error-budget-blocks-deploys",
    claim: "Deploys are blocked automatically once the week's error budget is spent, and the block clears on Monday.",
    evidence: "A release was held and the pipeline gave no reason beyond the budget check.",
  },

  // --- API surface ---------------------------------------------------------
  {
    id: "api-versioned-by-header",
    claim: "The API is versioned through an Accept header. There is no version segment in the URL path.",
    evidence: "A client that requested /v2/orders got a 404.",
  },
  {
    id: "breaking-change-over-two-releases",
    claim: "A breaking API change ships over two releases: add the new field in one, remove the old field in the next.",
    evidence: "A field removed in a single release broke two mobile versions still in the field.",
  },
  {
    id: "graphql-is-internal-only",
    claim: "The GraphQL endpoint is internal only and is not exposed through the public gateway.",
    evidence: "A partner integration was written against it and had to be redone on REST.",
  },

  // --- git -----------------------------------------------------------------
  {
    id: "squash-merge-only",
    claim: "Pull requests are squash-merged and the branch history is discarded, so the PR title is what lands as the commit message.",
    evidence: "A careful commit series arrived on main as one commit titled 'fixes'.",
  },
  {
    id: "no-force-push-after-review",
    claim: "Do not force-push a branch someone has already reviewed. Push a fixup commit so the review comments keep their anchors.",
    evidence: "A force-push detached every inline comment on a large review.",
  },
  {
    id: "commits-must-be-gpg-signed",
    claim: "Commits have to be GPG-signed or branch protection rejects the push.",
    evidence: "A push was rejected with a message that named only the rule, not the signature.",
  },

  // --- infrastructure ------------------------------------------------------
  {
    id: "terraform-state-in-s3",
    claim: "Terraform state lives in the shared S3 bucket with DynamoDB locking. Never run apply against local state.",
    evidence: "A local-state apply destroyed a load balancer the shared state still claimed.",
  },
  {
    id: "k8s-set-requests-not-limits",
    claim: "Set CPU requests and leave CPU limits unset. A limit throttles the pod under burst.",
    evidence: "Latency spikes traced back to CFS throttling on a pod with a CPU limit.",
  },
  {
    id: "staging-cluster-scales-to-zero",
    claim: "The staging cluster scales to zero overnight, so the first request each morning waits about forty seconds for a cold start.",
    evidence: "A morning smoke test failed on a timeout that nothing else reproduced.",
  },

  // --- data ----------------------------------------------------------------
  {
    id: "no-pii-in-analytics",
    claim: "No PII goes into the analytics pipeline. Hash the user id at the producer before it is emitted.",
    evidence: "An email address reached the warehouse and had to be deleted downstream.",
  },
  {
    id: "timestamps-stored-in-utc",
    claim: "Every stored timestamp is UTC. The timezone is applied at render time and nowhere else.",
    evidence: "A report was off by an hour for two weeks after a DST change.",
  },
];

/** The corpus in the shape `rebuildIndex` and the signposts table take. */
export const EVAL_CORPUS: readonly ActiveSignpost[] = ENTRIES.map((entry, index) => ({
  id: entry.id,
  claim: entry.claim,
  evidence: entry.evidence,
  // Content hashes are never compared in this eval — the index is rebuilt from
  // these rows directly — so a stable counter is enough and avoids hashing
  // forty claims on every run.
  content_hash: `eval-hash-${index}`,
}));

export const EVAL_CORPUS_IDS: ReadonlySet<string> = new Set(EVAL_CORPUS.map((s) => s.id));
