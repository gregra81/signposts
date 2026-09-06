// What a run command is handed, and where it comes from.
//
// The three run commands need resources whose lifetime is one invocation: a
// database handle, a checkpointer, and an embedder that loads an ONNX pipeline
// when it is built. None of that can be constructed eagerly at the composition
// root — `doctor` must run in a repo with no database, and `init` must not
// open one before consent — so what the root hands down is this: a function
// that opens them, and a handle that closes them again.
//
// That keeps R2 intact. The commands below construct nothing; production wires
// this in src/io/production-app.ts, and a test substitutes it at the same
// seam.

import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { ResolvedConfig } from "../core/config/resolve.ts";
import type { ExtractionGraph, GraphPorts } from "../graph/index.ts";

/** One eligible transcript — what `sessions` lists and `run` picks from. */
export interface RunSession {
  sessionId: string;
  contentHash: string;
  transcriptPath: string;
  lastActivityAt: Date;
}

/** What a finished session is recorded as, so no later run picks it up again. */
export interface FinishedSession {
  sessionId: string;
  contentHash: string;
  lastActivityAt: Date;
  tokenEstimate: number | null;
}

export interface RunHandle {
  /** The "owner/name" key, from the origin remote. */
  repo: string;
  graph: ExtractionGraph;
  checkpointer: BaseCheckpointSaver;
  /** Proposals reach the next session through this — see runResume's report. */
  pendingIndex: GraphPorts["pendingIndex"];
  /** Eligible sessions for this repo, oldest activity first. */
  eligible(now: Date): RunSession[];
  /** Records a session as processed, and the repo as past its bootstrap run. */
  finish(session: FinishedSession): void;
  close(): void;
}

/** Why a run could not be opened, phrased for the person who typed the command. */
export interface RunUnavailable {
  reason: string;
}

export type OpenedRun = { handle: RunHandle } | RunUnavailable;

export function isUnavailable(opened: OpenedRun): opened is RunUnavailable {
  return "reason" in opened;
}

export type OpenRun = (input: {
  config: ResolvedConfig;
  repoRoot: string;
  /** Where a step that could not finish says so. */
  warn: (message: string) => void;
}) => Promise<OpenedRun>;
