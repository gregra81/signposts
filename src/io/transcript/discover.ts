// Which of this repo's Claude Code sessions a run should process
// (02-ingestion.md, "Eligibility").
//
// Only this repo's transcript directory is read: the run happens in a repo,
// and a session belonging to another project is not this run's business.
//
// The three facts eligibility gates on come from the file rather than from
// its contents: the modification time is the last activity, the birth time is
// the start, and the sha256 of the bytes is the content hash that — with the
// session id — says whether this exact transcript has already been processed.
// Reading each file twice (once to hash, once to gutter) is the price of not
// having to gutter every transcript on disk to find out which two are
// eligible.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isEligible } from "../../core/eligibility/eligibility.ts";
import { projectDirName } from "../../core/transcript/project-dir.ts";

const TRANSCRIPT_EXTENSION = ".jsonl";

export interface DiscoveredSession {
  sessionId: string;
  contentHash: string;
  transcriptPath: string;
  lastActivityAt: Date;
}

export interface DiscoverInput {
  /** `~/.claude/projects`, already expanded. */
  transcriptRoot: string;
  repoRoot: string;
  /** `${sessionId}:${contentHash}` for everything already processed. */
  processedKeys: ReadonlySet<string>;
  now: Date;
}

/** Eligible sessions, oldest activity first — the order a run should process them in. */
export function discoverSessions(input: DiscoverInput): DiscoveredSession[] {
  const projectDir = path.join(input.transcriptRoot, projectDirName(input.repoRoot));

  let entries: string[];
  try {
    entries = readdirSync(projectDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // No transcripts for this repo yet — not an error, just nothing to do.
      return [];
    }
    throw error;
  }

  const found: DiscoveredSession[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(TRANSCRIPT_EXTENSION)) {
      continue;
    }
    const transcriptPath = path.join(projectDir, entry);
    const stats = statSync(transcriptPath);
    const sessionId = entry.slice(0, -TRANSCRIPT_EXTENSION.length);
    const contentHash = createHash("sha256").update(readFileSync(transcriptPath)).digest("hex");

    const eligible = isEligible(
      {
        sessionId,
        contentHash,
        lastActivityAt: stats.mtime,
        startedAt: stats.birthtime,
        // Both true by construction: the directory is this repo's, and a
        // subagent's lines are dropped per line by the gutter, not per file.
        inGitRepo: true,
        isSidechain: false,
        processedKeys: input.processedKeys,
      },
      input.now,
    );
    if (eligible) {
      found.push({ sessionId, contentHash, transcriptPath, lastActivityAt: stats.mtime });
    }
  }

  return found.sort((a, b) => a.lastActivityAt.getTime() - b.lastActivityAt.getTime());
}
