// Behaviour tests for the MCP read path: real git repo, real SQLite, real
// sqlite-vec, real embedder against the pinned model. No mocking, per
// 16-build-plan.md's "no test-double framework" rule.
//
// What is being proved is one claim in four states — a search answers, and
// never throws, whether or not there is an index to search (05-retrieval.md,
// "The MCP server on a cold clone"; 15-spec.md's cold-clone acceptance row).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig, type ResolvedConfig } from "../../../src/core/config/resolve.js";
import { serialiseSignpost } from "../../../src/core/signpost/codec.js";
import type { Signpost } from "../../../src/core/signpost/schema.js";
import { DEFAULT_SEARCH_LIMIT, diagnosticFor, SEARCH_UNAVAILABLE } from "../../../src/core/mcp/search-tool.js";
import { createSearchService } from "../../../src/io/mcp/search-service.js";
import { openDb } from "../../../src/io/db/migrate.js";
import { runCli } from "../helpers/run-cli.js";
import { createFakeStdio } from "../helpers/fake-stdio.js";
import { testLocalModelPath, testModelCache } from "../../support/model-cache.js";

const modelCacheRoot = testModelCache();

const REPO = "test/repo";

function signpost(overrides: Partial<Signpost> & Pick<Signpost, "id" | "claim">): Signpost {
  return {
    category: "gotcha",
    scope: { repo: REPO },
    evidence: "Observed once in a session.",
    confidence: 0.9,
    provenance: {
      session_ids: ["session-1"],
      authors: ["author-abcd"],
      first_seen: "2026-01-01T00:00:00.000Z",
      last_reinforced: "2026-01-01T00:00:00.000Z",
    },
    status: "active",
    ...overrides,
  };
}

const STAGING = signpost({
  id: "staging-db-read-only",
  claim: "The staging database is read-only; run migrations against dev instead.",
  evidence: "A migration run against staging failed with a permissions error.",
  scope: { repo: REPO, paths: ["src/db"] },
});

const PRISMA = signpost({
  id: "prisma-schema-path",
  claim: "The Prisma schema lives at prisma/schema.prisma, not schema/prisma.",
  evidence: "A generate step failed after looking in the wrong directory.",
});

describe("the search_signposts read path", () => {
  let homeDir: string;
  let repoRoot: string;
  let config: ResolvedConfig;
  const warnings: string[] = [];

  function service() {
    return createSearchService({
      config,
      repoRoot,
      warn: (message) => {
        warnings.push(message);
      },
    });
  }

  function search(query: string, extra: { paths?: readonly string[]; limit?: number } = {}) {
    return service().search({
      query,
      limit: extra.limit ?? DEFAULT_SEARCH_LIMIT,
      ...(extra.paths === undefined ? {} : { paths: extra.paths }),
    });
  }

  function writeSignpostFile(s: Signpost): void {
    mkdirSync(config.paths.knowledgeDir, { recursive: true });
    writeFileSync(path.join(config.paths.knowledgeDir, `${s.id}.md`), serialiseSignpost(s), "utf8");
  }

  async function buildIndex(): Promise<void> {
    const exitCode = await runCli(["index"], { config, stdio: createFakeStdio() });
    expect(exitCode).toBe(0);
  }

  beforeEach(() => {
    warnings.length = 0;
    homeDir = mkdtempSync(path.join(tmpdir(), "signposts-mcp-home-"));
    repoRoot = mkdtempSync(path.join(tmpdir(), "signposts-mcp-repo-"));
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
    execFileSync("git", ["remote", "add", "origin", `git@github.com:${REPO}.git`], { cwd: repoRoot });
    const resolved = resolveConfig({ repoRoot, homeDir, env: {} });
    config = {
      ...resolved,
      paths: { ...resolved.paths, modelCacheDir: modelCacheRoot },
      // The suite runs with the network denied — see test/support/global-setup.ts.
      retrieval: { ...resolved.retrieval, allow_remote_models: false, local_model_path: testLocalModelPath() },
    };
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("answers a cold clone with an empty result and a diagnostic, and creates no database", async () => {
    // The whole point of the read path: a new hire has cloned the repo, run
    // nothing, and consented to nothing. A search must not be the thing that
    // creates state for them (R3).
    const output = await search("can I run migrations against staging");

    expect(output.results).toEqual([]);
    expect(output.diagnostic).toBe(diagnosticFor(SEARCH_UNAVAILABLE.no_index));
    expect(existsSync(config.paths.dbPath)).toBe(false);
  });

  it(
    "finds a signpost by meaning once the index is built",
    async () => {
      writeSignpostFile(STAGING);
      writeSignpostFile(PRISMA);
      await buildIndex();

      // Not one word of the claim: this is the differently-worded case
      // 05-retrieval.md's first acceptance criterion is about.
      const output = await search("is it safe to apply schema changes to the pre-production environment");

      expect(output.diagnostic).toBeUndefined();
      expect(output.results.map((hit) => hit.id)).toContain(STAGING.id);
      const hit = output.results.find((result) => result.id === STAGING.id);
      expect(hit).toMatchObject({
        claim: STAGING.claim,
        category: STAGING.category,
        evidence: STAGING.evidence,
        confidence: STAGING.confidence,
      });
      expect(hit?.score).toBeGreaterThan(0);
    },
    60_000,
  );

  it(
    "honours the limit it was given",
    async () => {
      writeSignpostFile(STAGING);
      writeSignpostFile(PRISMA);
      await buildIndex();

      const output = await search("database", { limit: 1 });

      expect(output.results.length).toBeLessThanOrEqual(1);
    },
    60_000,
  );

  it(
    "says the index is stale rather than answering from a corpus the repo has moved past",
    async () => {
      writeSignpostFile(STAGING);
      await buildIndex();

      // A row in the mirror that the vector/FTS index has never seen — the
      // same disagreement `signpost index` acts on, reached here without
      // rebuilding.
      const db = openDb(config.paths.dbPath);
      db.prepare(
        `INSERT INTO signposts
           (id, repo, claim, category, evidence, scope_json, confidence, status, provenance_json,
            is_pending, pending_review, content_hash, embedding_model, embedding_dim)
         VALUES (?, ?, ?, 'gotcha', ?, ?, 0.9, 'active', '{}', 0, 0, 'hash-new', '', 0)`,
      ).run("added-later", REPO, "Something recorded after the last index run.", "evidence", JSON.stringify({ repo: REPO }));
      db.close();

      const output = await search("can I run migrations against staging");

      expect(output.results).toEqual([]);
      expect(output.diagnostic).toBe(diagnosticFor(SEARCH_UNAVAILABLE.stale_index));
    },
    60_000,
  );

  it(
    "explains an index with nothing in it, instead of returning a bare empty list",
    async () => {
      // A repo that has consented and indexed but recorded nothing yet. There
      // is no similarity floor by design (13-constants.md's MIN_SIMILARITY is
      // deliberately absent), so this — not a distant query — is the case
      // where a healthy index returns nothing.
      await buildIndex();

      const output = await search("can I run migrations against staging");

      expect(output.results).toEqual([]);
      expect(output.diagnostic).toBe(diagnosticFor(SEARCH_UNAVAILABLE.no_match));
    },
    60_000,
  );

  it("reports a checkout with no origin remote instead of failing", async () => {
    execFileSync("git", ["remote", "remove", "origin"], { cwd: repoRoot });

    const output = await search("anything at all");

    expect(output.results).toEqual([]);
    expect(output.diagnostic).toBe(diagnosticFor(SEARCH_UNAVAILABLE.no_repo));
  });

  it("reports an unreadable database instead of throwing it into the turn", async () => {
    mkdirSync(path.dirname(config.paths.dbPath), { recursive: true });
    writeFileSync(config.paths.dbPath, "this is not a SQLite file", "utf8");

    const output = await search("anything at all");

    expect(output.results).toEqual([]);
    expect(output.diagnostic).toBe(diagnosticFor(SEARCH_UNAVAILABLE.no_index));
  });
});
