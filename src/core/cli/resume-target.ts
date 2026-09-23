// Which halted thread a `signpost resume` is about, when the caller did not
// name it in full (19-value-to-a-user.md, open item 2).
//
// Driving the loop by hand meant copying `--content-hash` out of every halt.
// The hash cannot be re-derived from the transcript — the developer may have
// carried on in that session, and a grown transcript hashes to a different
// thread — but it does not have to be: the halted thread carries the hash its
// halt reported. So the lookup reads the checkpoint database, and this decides
// among what it found. Exactly one match proceeds; none, or several, is an
// error that lists the candidates, because guessing between two threads is how
// an answer lands on the wrong one.
//
// Pure: the halted sessions and the flags in, the one to resume or the reason
// there is none out.

export interface HaltedCandidate {
  sessionId: string;
  contentHash: string;
}

export interface ResumeFlags {
  sessionId?: string;
  contentHash?: string;
}

export type ResumeTarget = { session: HaltedCandidate } | { error: string };

export function chooseResumeTarget(
  halted: readonly HaltedCandidate[],
  flags: ResumeFlags,
): ResumeTarget {
  const matching = halted.filter(
    (candidate) =>
      (flags.sessionId === undefined || candidate.sessionId === flags.sessionId) &&
      (flags.contentHash === undefined || candidate.contentHash === flags.contentHash),
  );

  if (matching.length === 1) {
    return { session: matching[0]! };
  }
  if (matching.length === 0) {
    return {
      error:
        flags.sessionId === undefined
          ? "nothing is halted in this repo — `signpost run` starts a session"
          : `session ${flags.sessionId} has no halted thread to resume — \`signpost run --session ${flags.sessionId}\` starts it`,
    };
  }
  const lines = matching.map(
    (candidate) => `  --session ${candidate.sessionId} --content-hash ${candidate.contentHash}`,
  );
  return {
    error: `${String(matching.length)} halted threads match; name one:\n${lines.join("\n")}`,
  };
}
