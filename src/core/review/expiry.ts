// When a parked review expires, and whether that is close enough to say so
// (19-value-to-a-user.md item 3). PURE: dates in, dates and counts out.
//
// hooks/session-start.ts and statusline/statusline.ts transcribe
// `daysLeftToWarn`, because neither may import from `src/`.

import { REVIEW_EXPIRY_WARN_DAYS, THREAD_EXPIRY_DAYS } from "../config/constants.ts";

const MS_PER_DAY = 86_400_000;

/** When a review checkpointed at `waitingSince` is dropped. */
export function reviewExpiresAt(waitingSince: Date): Date {
  return new Date(waitingSince.getTime() + THREAD_EXPIRY_DAYS * MS_PER_DAY);
}

/**
 * Whole days left, rounded up so a review with 2 days and an hour left says 3,
 * or undefined when that is further off than REVIEW_EXPIRY_WARN_DAYS. Nothing
 * left rounds to 0, which is still worth saying.
 */
export function daysLeftToWarn(expiresAt: Date, now: Date): number | undefined {
  const days = Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / MS_PER_DAY));
  return days <= REVIEW_EXPIRY_WARN_DAYS ? days : undefined;
}

/** The soonest of several expiries, or undefined when there are none. */
export function soonestExpiry(expiries: readonly Date[]): Date | undefined {
  return expiries.length === 0 ? undefined : new Date(Math.min(...expiries.map((expiry) => expiry.getTime())));
}
