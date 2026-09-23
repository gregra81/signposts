// Eligibility gate (02-ingestion.md "Eligibility"). PURE, no IO — session
// metadata in, decision out. Size and content gates live elsewhere (they
// need transcript/gutter output, not session metadata).

import { IDLE_HOURS, MAX_AGE_DAYS } from "../config/constants.ts";
import type { Session } from "./types.ts";

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/**
 * How long a session must have been quiet, and how far back to look.
 *
 * Both are configurable (`thresholds.idle_hours`, `thresholds.max_age_days`,
 * and the SIGNPOSTS_THRESHOLDS_* variables), and until 2026-09-23 this module
 * ignored the config and used the constants — so the documented override did
 * nothing, including the one a person reaches for to try the tool without
 * waiting a day (19-value-to-a-user.md, open items).
 */
export interface EligibilityThresholds {
  idleHours: number;
  maxAgeDays: number;
}

/** The compile-time defaults, for a caller that has no config to hand. */
export const DEFAULT_ELIGIBILITY: EligibilityThresholds = {
  idleHours: IDLE_HOURS,
  maxAgeDays: MAX_AGE_DAYS,
};

/** All gates must hold: idle long enough, not too old, in a git repo, main session, not already processed. */
export function isEligible(
  session: Session,
  now: Date,
  thresholds: EligibilityThresholds = DEFAULT_ELIGIBILITY,
): boolean {
  const nowMs = now.getTime();

  const idle = nowMs - session.lastActivityAt.getTime() >= thresholds.idleHours * MS_PER_HOUR;
  const notTooOld = nowMs - session.startedAt.getTime() <= thresholds.maxAgeDays * MS_PER_DAY;
  const key = `${session.sessionId}:${session.contentHash}`;
  const notProcessed = !session.processedKeys.has(key);

  return idle && notTooOld && session.inGitRepo && !session.isSidechain && notProcessed;
}
