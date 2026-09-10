// `signpost index` (R4): read every `.signposts/**/*.md`, parse, mirror
// active signposts into the `signposts` table, rebuild the vector/FTS
// index, regenerate `index.md`. Thin orchestration: the first three are
// src/io/signpost/sync-corpus.ts, which the run path calls too, and index
// generation is src/core/signpost/index-doc.ts.

import { existsSync, writeFileSync } from "node:fs";
import type { ExitCode } from "../../app.ts";
import type { ResolvedConfig } from "../../core/config/resolve.ts";
import { indexExitCode } from "../../core/cli/index-exit-code.ts";
import { generateIndexDoc } from "../../core/signpost/index-doc.ts";
import { openDb } from "../../io/db/migrate.ts";
import { syncCorpus } from "../../io/signpost/sync-corpus.ts";
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

  let db;
  try {
    db = openDb(config.paths.dbPath);
  } catch {
    stderr.write(`signposts: database at ${config.paths.dbPath} is corrupt or unreadable.\n`);
    return 1;
  }

  let result;
  try {
    result = await syncCorpus({
      db,
      repo,
      knowledgeDir: config.paths.knowledgeDir,
      modelCacheDir: config.paths.modelCacheDir,
      retrieval: config.retrieval,
    });
  } finally {
    db.close();
  }

  for (const failure of result.failures) {
    stderr.write(`signposts: ${failure}\n`);
  }

  writeIndexDoc(config, result.parsed);

  return indexExitCode(result.failures.length > 0);
}

/**
 * Regenerates `index.md`, unless writing it would create the file out of
 * nothing.
 *
 * The documented setup order is `init` then `index`, so on a fresh repo this
 * ran with an empty corpus and left an *untracked* `.signposts/index.md`
 * holding no signposts. The first pull request adds a *tracked* one, and git
 * then refuses the merge outright — "the following untracked working tree
 * files would be overwritten by merge" — at the last step of the loop, where a
 * git error is least expected, with `rm .signposts/index.md` as a workaround
 * nothing tells anyone about (18-end-to-end-gaps.md, item 1).
 *
 * So the file is written when there is a corpus to describe, or when it is
 * already there — which after that first merge means tracked, and regenerated
 * from the same corpus the branch generated it from, so it stays clean. An
 * empty corpus and no file is the one case that writes nothing: there is no
 * index to publish, and the absence is what lets the merge land.
 */
function writeIndexDoc(config: ResolvedConfig, parsed: Parameters<typeof generateIndexDoc>[0]): void {
  if (parsed.length === 0 && !existsSync(config.paths.indexFile)) {
    return;
  }
  ensureKnowledgeDir(config.paths.knowledgeDir);
  writeFileSync(config.paths.indexFile, generateIndexDoc(parsed), "utf8");
}
