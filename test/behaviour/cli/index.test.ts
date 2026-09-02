// Behaviour tests for `signpost index` (R4, R8) at the CLI seam: real fs,
// real SQLite, real embedder, driven through runCli.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig, type ResolvedConfig } from "../../../src/core/config/resolve.js";
import { serialiseSignpost } from "../../../src/core/signpost/codec.js";
import type { Signpost } from "../../../src/core/signpost/schema.js";
import { deriveOwnerRepo } from "../../../src/core/git/owner-repo.js";
import { getOriginUrl } from "../../../src/io/git/remote-origin.js";
import { openDb } from "../../../src/io/db/migrate.js";
import { runCli } from "../helpers/run-cli.js";
import { createFakeStdio } from "../helpers/fake-stdio.js";
import { fakePorts, NO_CREDENTIALS } from "../helpers/fake-ports.js";
import { testLocalModelPath, testModelCache } from "../../support/model-cache.js";

function signpost(overrides: Partial<Signpost> & Pick<Signpost, "id" | "claim">): Signpost {
  return {
    category: "gotcha",
    scope: { repo: "acme/platform" },
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

const modelCacheRoot = testModelCache();

describe("signpost index", () => {
  let homeDir: string;
  let repoRoot: string;
  let config: ResolvedConfig;
  let repo: string;

  beforeEach(() => {
    homeDir = mkdtempSync(path.join(tmpdir(), "signposts-index-home-"));
    repoRoot = mkdtempSync(path.join(tmpdir(), "signposts-index-repo-"));
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:test/repo.git"], { cwd: repoRoot });
    const originUrl = getOriginUrl(repoRoot);
    repo = (originUrl !== null ? deriveOwnerRepo(originUrl) : null) ?? "test/repo";
    config = resolveConfig({ repoRoot, homeDir, env: {} });
    // Share one model cache dir across this file's tests (avoids re-downloading).
    config = {
      ...config,
      paths: { ...config.paths, modelCacheDir: modelCacheRoot },
      // Resolve the model from the local copy global-setup.ts prepared, so
      // this suite needs no network. The defaults allow remote models, which
      // makes transformers.js fetch file metadata even from a warm cache.
      retrieval: {
        ...config.retrieval,
        allow_remote_models: false,
        local_model_path: testLocalModelPath(),
      },
    };
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function writeSignpostFile(s: Signpost): void {
    mkdirSync(config.paths.knowledgeDir, { recursive: true });
    writeFileSync(path.join(config.paths.knowledgeDir, `${s.id}.md`), serialiseSignpost(s), "utf8");
  }

  it(
    "zero signposts: index.md says so, no rows mirrored",
    async () => {
      const exitCode = await runCli(["index"], {
        config,
        ports: fakePorts(),
        credentials: NO_CREDENTIALS,
        stdio: createFakeStdio(),
      });

      expect(exitCode).toBe(0);
      expect(readFileSync(config.paths.indexFile, "utf8")).toBe("# Signposts\n\nNo active signposts.\n");

      const db = openDb(config.paths.dbPath);
      try {
        const rows = db.prepare("SELECT * FROM signposts WHERE repo = ?").all(repo);
        expect(rows).toHaveLength(0);
      } finally {
        db.close();
      }
    },
    120_000,
  );

  it(
    "N signposts: mirrors active ones into the signposts table and regenerates index.md",
    async () => {
      writeSignpostFile(signpost({ id: "staging-db-read-only", claim: "The staging database is read-only." }));
      writeSignpostFile(signpost({ id: "make-build-first", claim: "Run make build before make test." }));

      const exitCode = await runCli(["index"], {
        config,
        ports: fakePorts(),
        credentials: NO_CREDENTIALS,
        stdio: createFakeStdio(),
      });

      expect(exitCode).toBe(0);

      const indexDoc = readFileSync(config.paths.indexFile, "utf8");
      expect(indexDoc).toContain("staging-db-read-only");
      expect(indexDoc).toContain("make-build-first");

      const db = openDb(config.paths.dbPath);
      try {
        const rows = db
          .prepare("SELECT id, claim, status FROM signposts WHERE repo = ? ORDER BY id")
          .all(repo) as Array<{ id: string; claim: string; status: string }>;
        expect(rows).toHaveLength(2);
        expect(rows.map((r) => r.id)).toEqual(["make-build-first", "staging-db-read-only"]);

        const meta = db.prepare("SELECT corpus_hash FROM index_meta WHERE repo = ?").get(repo);
        expect(meta).toBeDefined();
      } finally {
        db.close();
      }
    },
    120_000,
  );

  it(
    "running index twice leaves embedding_model/embedding_dim populated on the second run",
    async () => {
      writeSignpostFile(signpost({ id: "staging-db-read-only", claim: "The staging database is read-only." }));

      await runCli(["index"], {
        config,
        ports: fakePorts(),
        credentials: NO_CREDENTIALS,
        stdio: createFakeStdio(),
      });
      const exitCode = await runCli(["index"], {
        config,
        ports: fakePorts(),
        credentials: NO_CREDENTIALS,
        stdio: createFakeStdio(),
      });

      expect(exitCode).toBe(0);

      const db = openDb(config.paths.dbPath);
      try {
        const row = db
          .prepare("SELECT embedding_model, embedding_dim FROM signposts WHERE repo = ? AND id = ?")
          .get(repo, "staging-db-read-only") as { embedding_model: string; embedding_dim: number };
        expect(row.embedding_model).not.toBe("");
        expect(row.embedding_dim).toBeGreaterThan(0);
      } finally {
        db.close();
      }
    },
    120_000,
  );

  it(
    "a superseded signpost is excluded from both the mirror and index.md",
    async () => {
      writeSignpostFile(signpost({ id: "active-one", claim: "This is the active claim." }));
      writeSignpostFile(
        signpost({ id: "old-claim", claim: "This claim was superseded.", status: "superseded" }),
      );

      await runCli(["index"], {
        config,
        ports: fakePorts(),
        credentials: NO_CREDENTIALS,
        stdio: createFakeStdio(),
      });

      const indexDoc = readFileSync(config.paths.indexFile, "utf8");
      expect(indexDoc).toContain("active-one");
      expect(indexDoc).not.toContain("old-claim");

      const db = openDb(config.paths.dbPath);
      try {
        const rows = db.prepare("SELECT id FROM signposts WHERE repo = ?").all(repo) as Array<{ id: string }>;
        expect(rows.map((r) => r.id)).toEqual(["active-one"]);
      } finally {
        db.close();
      }
    },
    120_000,
  );

  it(
    "a malformed signpost file is skipped with a stderr warning, valid ones still index, exit code 1",
    async () => {
      writeSignpostFile(signpost({ id: "staging-db-read-only", claim: "The staging database is read-only." }));
      writeSignpostFile(signpost({ id: "make-build-first", claim: "Run make build before make test." }));
      mkdirSync(config.paths.knowledgeDir, { recursive: true });
      const badFile = path.join(config.paths.knowledgeDir, "broken.md");
      writeFileSync(badFile, "this is not a valid signpost file at all\n", "utf8");

      const stdio = createFakeStdio();
      const exitCode = await runCli(["index"], {
        config,
        ports: fakePorts(),
        credentials: NO_CREDENTIALS,
        stdio,
      });

      expect(exitCode).toBe(1);
      expect(stdio.writtenError()).toContain(badFile);

      const indexDoc = readFileSync(config.paths.indexFile, "utf8");
      expect(indexDoc).toContain("staging-db-read-only");
      expect(indexDoc).toContain("make-build-first");

      const db = openDb(config.paths.dbPath);
      try {
        const rows = db
          .prepare("SELECT id FROM signposts WHERE repo = ? ORDER BY id")
          .all(repo) as Array<{ id: string }>;
        expect(rows.map((r) => r.id)).toEqual(["make-build-first", "staging-db-read-only"]);
      } finally {
        db.close();
      }
    },
    120_000,
  );
});
