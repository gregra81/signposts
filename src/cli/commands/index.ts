// `signpost index` (R4): read every `.signposts/**/*.md`, parse, mirror
// active signposts into the `signposts` table, rebuild the vector/FTS
// index, regenerate `index.md`. Thin orchestration: parsing is
// src/core/signpost/codec.ts, filtering uses the existing ACTIVE_STATUS
// constant, index generation is src/core/signpost/index-doc.ts — nothing
// new to decide here beyond wiring those together.

import { writeFileSync } from "node:fs";
import { ZodError } from "zod";
import type { ExitCode } from "../../app.ts";
import type { ResolvedConfig } from "../../core/config/resolve.ts";
import { indexExitCode } from "../../core/cli/index-exit-code.ts";
import { formatZodError } from "../../core/errors/format-zod-error.ts";
import { parseSignpost } from "../../core/signpost/codec.ts";
import { contentHashFor } from "../../core/signpost/content-hash.ts";
import { generateIndexDoc } from "../../core/signpost/index-doc.ts";
import type { Signpost } from "../../core/signpost/schema.ts";
import { ACTIVE_STATUS } from "../../core/signpost/schema.ts";
import { openDb } from "../../io/db/migrate.ts";
import { rebuildIndex, type ActiveSignpost } from "../../io/db/vector-index.ts";
import { mirrorSignposts } from "../../io/db/signposts.ts";
import { readSignpostFiles } from "../../io/signpost/read-dir.ts";
import { ensureKnowledgeDir } from "../../io/init/signposts-dir.ts";
import { resolveRepo } from "../../io/git/remote-origin.ts";

export interface RunIndexInput {
  config: ResolvedConfig;
  repoRoot: string;
  stderr: NodeJS.WritableStream;
}

export async function runIndex({ config, repoRoot, stderr }: RunIndexInput): Promise<ExitCode> {
  // `repo` (the signposts/index_meta key) comes from the `origin` git remote —
  // resolved here rather than eagerly at the composition root (see
  // src/io/production-app.ts) so a repo with no GitHub origin fails gracefully.
  const repo = resolveRepo(repoRoot);
  if (repo === null) {
    stderr.write(
      "signposts: could not determine repo (owner/name) from the 'origin' git remote — is this a git repo with a GitHub origin configured?\n",
    );
    return 1;
  }

  const files = readSignpostFiles(config.paths.knowledgeDir);
  const parsed: Signpost[] = [];
  let anyFileFailed = false;
  for (const file of files) {
    try {
      parsed.push(parseSignpost(file.content));
    } catch (error) {
      anyFileFailed = true;
      const message =
        error instanceof ZodError
          ? formatZodError(error)
          : error instanceof Error
            ? error.message
            : String(error);
      stderr.write(`signposts: skipping ${file.path}: ${message}\n`);
    }
  }
  const active = parsed.filter((signpost) => signpost.status === ACTIVE_STATUS);
  const activeWithHash = active.map((signpost) => ({ signpost, contentHash: contentHashFor(signpost) }));

  let db;
  try {
    db = openDb(config.paths.dbPath);
  } catch {
    stderr.write(`signposts: database at ${config.paths.dbPath} is corrupt or unreadable.\n`);
    return 1;
  }
  try {
    mirrorSignposts(db, repo, activeWithHash);

    const activeSignposts: ActiveSignpost[] = activeWithHash.map(({ signpost, contentHash }) => ({
      id: signpost.id,
      content_hash: contentHash,
      claim: signpost.claim,
      evidence: signpost.evidence,
    }));
    await rebuildIndex(db, {
      modelCacheDir: config.paths.modelCacheDir,
      retrieval: config.retrieval,
      repo,
      signposts: activeSignposts,
    });
  } finally {
    db.close();
  }

  ensureKnowledgeDir(config.paths.knowledgeDir);
  writeFileSync(config.paths.indexFile, generateIndexDoc(parsed), "utf8");

  return indexExitCode(anyFileFailed);
}
