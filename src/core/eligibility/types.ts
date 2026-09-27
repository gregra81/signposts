// Shapes for eligibility (02-ingestion.md "Eligibility").

/** Session metadata isEligible gates on. io resolves inGitRepo before this is called. */
export type Session = {
  sessionId: string;
  contentHash: string;
  lastActivityAt: Date;
  startedAt: Date;
  inGitRepo: boolean;
  isSidechain: boolean;
  /** When Claude Code said this session ended, from the SessionEnd hook's marker. Absent when it never did. */
  endedAt?: Date;
  /** Compound `${sessionId}:${contentHash}` keys already completed. */
  processedKeys: ReadonlySet<string>;
};
