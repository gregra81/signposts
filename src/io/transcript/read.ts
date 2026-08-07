// Streaming reader for Claude Code JSONL transcripts — 02-ingestion.md
// "Parser requirements", 15-spec.md D3. Transcripts reach hundreds of MB,
// so this reads line by line via readline over a read stream and never
// loads the file into memory or JSON.parses the whole thing at once. This
// module only does the filesystem streaming (create stream, create
// readline interface, iterate raw lines, close in finally) and the
// logger side effect; every decision — counters, version tracking,
// warn-once, malformed/ignored/parsed routing, what to yield — is the
// pure reducer at src/core/transcript/advance.ts.

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { advance, createTranscriptReadState, type TranscriptCounts } from "../../core/transcript/advance.js";
import type { TranscriptLine } from "../../core/contracts/schema.js";

export type { TranscriptCounts };

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
  const state = createTranscriptReadState();

  async function* generate(): AsyncGenerator<TranscriptLine> {
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    try {
      for await (const raw of rl) {
        const result = advance(state, raw);
        if (result.warn !== undefined) {
          logger(result.warn);
        }
        if (result.emit !== undefined) {
          yield result.emit;
        }
      }
    } finally {
      rl.close();
      stream.destroy();
    }
  }

  return { lines: generate(), counts: state.counts };
}
