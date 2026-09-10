// What `--verbose` narrates (15-spec.md story 71: "run everything manually
// and verbosely… use the tool without the plugin and debug it when it
// misbehaves").
//
// Pure line building, no writing: the caller decides that these go to stderr,
// and stderr is the point. stdout carries one JSON object per invocation and
// that contract is what the skill parses, so nothing here may touch it.
//
// The lines answer the questions a person driving the loop by hand has to ask
// something else to answer today: which transcript is this, what state
// directory is it using, what is the halt actually waiting on, and what do I
// type next. The last one matters most — a halt hands back a session id and a
// content hash that must be passed exactly, and retyping them from a JSON
// blob is where a manual run goes wrong.

/** A session as the run commands know it, with the date already formatted. */
export interface VerboseSession {
  sessionId: string;
  contentHash: string;
  transcriptPath: string;
  lastActivityAt: string;
}

/** One halt, flattened: the graph's own types stay on the graph's side of this. */
export interface VerbosePending {
  /** `model_call` or `human_review`. */
  kind: string;
  /** The graph node that halted; absent on a review, which is the whole run's. */
  node?: string | undefined;
  /** LangGraph's interrupt id — what the answer is keyed by. */
  interruptId: string;
}

/** Where this invocation is reading and writing, for a bug report that names paths. */
export function contextLines(input: { repo: string; stateDir: string }): string[] {
  return [`repo ${input.repo}`, `state ${input.stateDir}`];
}

export function eligibleLine(count: number): string {
  return `${count} eligible session(s)`;
}

export function sessionLine(session: VerboseSession): string {
  return `  ${session.sessionId} (${session.contentHash}) last active ${session.lastActivityAt} — ${session.transcriptPath}`;
}

export function startingLine(session: VerboseSession): string {
  return `running session ${session.sessionId}, transcript ${session.transcriptPath}`;
}

export function resumingLine(session: VerboseSession, repliesPath: string, replyCount: number): string {
  return `resuming session ${session.sessionId} with ${replyCount} repl(y|ies) from ${repliesPath}`;
}

/**
 * What the run halted on, and the command that answers it.
 *
 * Every pending request is listed rather than summarised by count, because
 * `classify` fans out: several halts at once, each answered by its own
 * interrupt id, and answering them positionally hands one candidate's
 * classification to another.
 */
export function haltedLines(session: VerboseSession, pending: readonly VerbosePending[]): string[] {
  return [
    `halted on ${pending.length} request(s):`,
    ...pending.map((request) => `  ${request.kind}${request.node === undefined ? "" : ` at ${request.node}`} — answer under id ${request.interruptId}`),
    `next: signpost resume --session ${session.sessionId} --content-hash ${session.contentHash} --replies <file> --verbose`,
  ];
}

/** What a session that ran to the end proposed, and what is left of the run. */
export function finishedLines(proposed: readonly string[], remaining: number): string[] {
  return [
    `finished: ${proposed.length} operation(s) proposed`,
    ...proposed.map((line) => `  ${line}`),
    remaining === 0
      ? "nothing else eligible — the run is done"
      : `${remaining} session(s) still eligible; run again to take the next one`,
  ];
}
