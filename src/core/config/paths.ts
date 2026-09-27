// Derives the concrete, per-repo state paths from the path *pieces* in
// ./constants.ts. The constants module holds only the building blocks —
// directory names and filenames — because the concrete paths depend on
// `repoRoot` and `homeDir`, which are per-invocation inputs, not tunables.
//
// `repoRoot` and `homeDir` are passed in explicitly: this module calls
// neither `os.homedir()` nor reads any ambient state itself.

import { createHash } from "node:crypto";
import path from "node:path";
import {
  CHECKPOINT_FILENAME,
  DB_FILENAME,
  INDEX_FILENAME,
  LOCKFILE_FILENAME,
  ENDED_DIRNAME,
  MODEL_CACHE_DIRNAME,
  SIGNPOSTS_DIRNAME,
  CLAUDE_CONFIG_ROOT,
  STATUSLINE_FILENAME,
  TRANSCRIPT_DIRNAME,
  WORKTREE_DIRNAME,
} from "./constants.ts";

export interface DerivedPaths {
  /** The repoRoot derivePaths was called with, unnormalised. */
  repoRoot: string;
  /** First 12 hex chars of sha256(repoRoot). */
  repoHash: string;
  stateDir: string;
  dbPath: string;
  checkpointPath: string;
  statuslineState: string;
  lockfile: string;
  /** The SessionEnd hook's markers — see ENDED_DIRNAME. */
  endedDir: string;
  /** Global — NOT under stateDir. Shared across every repo on the machine. */
  modelCacheDir: string;
  knowledgeDir: string;
  indexFile: string;
  /** Second checkout of this repo, on the signposts branch — see WORKTREE_DIRNAME. */
  worktreeDir: string;
  /** Where Claude Code writes transcripts: its config directory, plus `projects`. */
  transcriptRoot: string;
}

/** The prefix CLAUDE_CONFIG_ROOT is written with — this module supplies the home. */
const HOME_PREFIX = "~/";

function expandHome(homeRelative: string, homeDir: string): string {
  return path.join(homeDir, homeRelative.slice(HOME_PREFIX.length));
}

/** sha256(repoRoot), hex-encoded, first 12 characters — repoRoot taken as given, unnormalised. */
export function hashRepoRoot(repoRoot: string): string {
  return createHash("sha256").update(repoRoot).digest("hex").slice(0, 12);
}

/**
 * Claude Code moves its whole config directory when `CLAUDE_CONFIG_DIR` is
 * set, transcripts included. Hard-coding `~/.claude` sent `discoverSessions`
 * to a root holding nothing, and its ENOENT branch reports that as an empty
 * session list — `sessions` prints nothing eligible and the skill correctly
 * stops, with no way to tell that from a repo with no idle transcripts. Same
 * silent-and-empty failure as the project directory name, through the other
 * half of the path.
 *
 * Read at the composition root and passed down (R7), not read here.
 */
export function derivePaths(
  repoRoot: string,
  homeDir: string,
  claudeConfigDir?: string | undefined,
): DerivedPaths {
  const repoHash = hashRepoRoot(repoRoot);
  const globalRoot = path.join(homeDir, SIGNPOSTS_DIRNAME);
  const stateDir = path.join(globalRoot, repoHash);
  const knowledgeDir = path.join(repoRoot, SIGNPOSTS_DIRNAME);

  return {
    repoRoot,
    repoHash,
    stateDir,
    dbPath: path.join(stateDir, DB_FILENAME),
    checkpointPath: path.join(stateDir, CHECKPOINT_FILENAME),
    statuslineState: path.join(stateDir, STATUSLINE_FILENAME),
    lockfile: path.join(stateDir, LOCKFILE_FILENAME),
    endedDir: path.join(stateDir, ENDED_DIRNAME),
    modelCacheDir: path.join(globalRoot, MODEL_CACHE_DIRNAME),
    knowledgeDir,
    indexFile: path.join(knowledgeDir, INDEX_FILENAME),
    worktreeDir: path.join(stateDir, WORKTREE_DIRNAME),
    transcriptRoot: path.join(
      claudeConfigDir === undefined || claudeConfigDir === ""
        ? expandHome(CLAUDE_CONFIG_ROOT, homeDir)
        : claudeConfigDir,
      TRANSCRIPT_DIRNAME,
    ),
  };
}
