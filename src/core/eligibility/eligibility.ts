// Eligibility gate (02-ingestion.md "Eligibility"). PURE, no IO — session
// metadata in, decision out. Size and content gates live elsewhere (they
// need transcript/gutter output, not session metadata).

import { IDLE_HOURS, MAX_AGE_DAYS } from "../config/constants.ts";
import type { Session } from "./types.ts";

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

const IDLE_MS = IDLE_HOURS * MS_PER_HOUR;
const MAX_AGE_MS = MAX_AGE_DAYS * MS_PER_DAY;

/** All gates must hold: idle long enough, not too old, in a git repo, main session, not already processed. */
export function isEligible(session: Session, now: Date): boolean {
  const nowMs = now.getTime();

  const idle = nowMs - session.lastActivityAt.getTime() >= IDLE_MS;
  const notTooOld = nowMs - session.startedAt.getTime() <= MAX_AGE_MS;
  const key = `${session.sessionId}:${session.contentHash}`;
  const notProcessed = !session.processedKeys.has(key);

  return idle && notTooOld && session.inGitRepo && !session.isSidechain && notProcessed;
}
