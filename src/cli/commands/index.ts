// `signpost index` (R4): read every `.signposts/**/*.md`, parse, mirror
// active signposts into the `signposts` table, rebuild the vector/FTS index.
// Thin orchestration — all three are src/io/signpost/sync-corpus.ts, which
// the run path calls too.
//
// **It does not write `index.md`.** That file is generated output, and the
// commit path already owns it: `writeCorpus` regenerates it from the whole
// corpus inside the second worktree and commits it with the proposals
// (src/io/commit/commit-port.ts). This command writing a second copy into the
// developer's checkout is what created 18-end-to-end-gaps.md item 1 — the
// documented setup order is `init` then `index`, so every fresh repo got an
// *untracked* `.signposts/index.md`, the first pull request adds a tracked
// one, and git refuses the merge at the last step of the loop with
// `rm .signposts/index.md` as a workaround nothing mentions.
//
// Scoping the write to an empty corpus closed only the first-run instance of
// that. A repo with a hand-written signpost file and no merged pull request
// still produced an untracked file and the same aborted merge — and `runWorker`
// reaches this same code, so a *background* process could create it, against
// CLAUDE.md's "a run never touches the developer's checkout". One writer
// removes the collision by construction rather than by case analysis.

import type { ExitCode } from "../../app.ts";
import type { ResolvedConfig } from "../../core/config/resolve.ts";
import { indexExitCode } from "../../core/cli/index-exit-code.ts";
import { openDb } from "../../io/db/migrate.ts";
import { syncCorpus } from "../../io/signpost/sync-corpus.ts";
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

  let failures: string[];
  try {
    ({ failures } = await syncCorpus({
      db,
      repo,
      knowledgeDir: config.paths.knowledgeDir,
      modelCacheDir: config.paths.modelCacheDir,
      retrieval: config.retrieval,
    }));
  } finally {
    db.close();
  }

  for (const failure of failures) {
    stderr.write(`signposts: ${failure}\n`);
  }

  return indexExitCode(failures.length > 0);
}
