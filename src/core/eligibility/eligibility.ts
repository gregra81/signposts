// Eligibility gate (02-ingestion.md "Eligibility"). PURE, no IO — session
// metadata in, decision out. Size and content gates live elsewhere (they
// need transcript/gutter output, not session metadata).

import { ENDED_IDLE_HOURS, ENDED_MARKER_SLACK_MINUTES, IDLE_HOURS, MAX_AGE_DAYS } from "../config/constants.ts";
import type { Session } from "./types.ts";

const MS_PER_MINUTE = 60_000;
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

  const idle = nowMs - session.lastActivityAt.getTime() >= idleHoursFor(session, thresholds) * MS_PER_HOUR;
  const notTooOld = nowMs - session.startedAt.getTime() <= thresholds.maxAgeDays * MS_PER_DAY;
  const key = `${session.sessionId}:${session.contentHash}`;
  const notProcessed = !session.processedKeys.has(key);

  return idle && notTooOld && session.inGitRepo && !session.isSidechain && notProcessed;
}

/**
 * How long this session has to have been quiet.
 *
 * A day, unless Claude Code said the session ended and nothing has been
 * written to it since — then ENDED_IDLE_HOURS, or the configured window when
 * that is shorter still (19-value-to-a-user.md, open item 5). A session
 * resumed after its end has activity past the marker, so the marker stops
 * counting and the full window applies again.
 */
function idleHoursFor(session: Session, thresholds: EligibilityThresholds): number {
  const endedMs = session.endedAt?.getTime();
  const ended =
    endedMs !== undefined &&
    endedMs >= session.lastActivityAt.getTime() - ENDED_MARKER_SLACK_MINUTES * MS_PER_MINUTE;
  return ended ? Math.min(ENDED_IDLE_HOURS, thresholds.idleHours) : thresholds.idleHours;
}
