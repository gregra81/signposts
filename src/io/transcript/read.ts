// Streaming reader for Claude Code JSONL transcripts — 02-ingestion.md
// "Parser requirements", 15-spec.md D3. Transcripts reach hundreds of MB,
// so this reads line by line via readline over a read stream and never
// loads the file into memory or JSON.parses the whole thing at once. Line
// parsing and validation themselves are pure (src/core/transcript/classify.ts);
// this module only does the filesystem streaming and the version-warning
// side effect.

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { parseLine, parseVersionMajor } from "../../core/transcript/classify.js";
import type { TranscriptLine } from "../../core/contracts/schema.js";

// Known envelope version majors. Local to this module (not constants.ts —
// see constants.ts header: it mirrors 13-constants.md, which has no
// schema-version row).
// eslint-disable-next-line signposts/no-magic-literal -- transcript envelope schema version major, not a 13-constants.md tunable
const KNOWN_VERSION_MAJORS = [2];

export interface TranscriptCounts {
  linesRead: number;
  /** Invalid JSON, or a known-type (user/assistant/system) line that failed its schema (R2). */
  linesSkipped: number;
  /** Valid JSON of a type ingestion doesn't handle (transcript sidecar records) — still yielded (R7/R8). */
  linesIgnored: number;
  versionsSeen: Set<string>;
}

export type TranscriptLogger = (message: string) => void;

export interface ReadTranscriptOptions {
  /** Called at most once per distinct unseen version major. Default: no-op. */
  logger?: TranscriptLogger;
}

export interface TranscriptRead {
  /**
   * Yields every line that parsed and validated, including unrecognised-type
   * (ignored) lines — the reader is a faithful view of the file; callers
   * that only want known types filter on `.type`. Malformed lines are
   * skipped, not yielded. Invariant: linesRead === (lines yielded) +
   * linesSkipped, where linesIgnored is a breakdown of what was yielded.
   */
  lines: AsyncGenerator<TranscriptLine>;
  /** Mutated as `lines` is consumed; final values are valid once iteration completes. */
  counts: TranscriptCounts;
}

/** Streams `filePath` line by line, never reading the whole file into memory (R1). */
export function readTranscript(filePath: string, options: ReadTranscriptOptions = {}): TranscriptRead {
  const logger = options.logger ?? (() => {});
  const counts: TranscriptCounts = {
    linesRead: 0,
    linesSkipped: 0,
    linesIgnored: 0,
    versionsSeen: new Set(),
  };
  const warnedMajors = new Set<number>();

  async function* generate(): AsyncGenerator<TranscriptLine> {
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    try {
      for await (const raw of rl) {
        counts.linesRead += 1;

        const result = parseLine(raw);
        if (result.status === "malformed") {
          counts.linesSkipped += 1;
          continue;
        }

        // Version tracking runs for both "parsed" and "ignored" lines (R4 is
        // unqualified by line type) — an ignored line's `version` is `unknown`
        // under looseObject's catchall, hence the typeof guard.
        const version = typeof result.line.version === "string" ? result.line.version : undefined;
        if (version !== undefined) {
          counts.versionsSeen.add(version);
          const major = parseVersionMajor(version);
          if (major !== undefined && !KNOWN_VERSION_MAJORS.includes(major) && !warnedMajors.has(major)) {
            warnedMajors.add(major);
            logger(`transcript version major ${major} is unseen (known: ${KNOWN_VERSION_MAJORS.join(", ")})`);
          }
        }

        if (result.status === "ignored") {
          counts.linesIgnored += 1;
        }

        yield result.line;
      }
    } finally {
      rl.close();
      stream.destroy();
    }
  }

  return { lines: generate(), counts };
}
