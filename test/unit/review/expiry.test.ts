import { describe, expect, it } from "vitest";
import { REVIEW_EXPIRY_WARN_DAYS, THREAD_EXPIRY_DAYS } from "../../../src/core/config/constants.ts";
import { daysLeftToWarn, reviewExpiresAt, soonestExpiry } from "../../../src/core/review/expiry.ts";

const DAY = 86_400_000;
const NOW = new Date("2026-09-16T12:00:00.000Z");

describe("reviewExpiresAt", () => {
  it("is THREAD_EXPIRY_DAYS after the halt", () => {
    expect(reviewExpiresAt(NOW).getTime() - NOW.getTime()).toBe(THREAD_EXPIRY_DAYS * DAY);
  });
});

describe("daysLeftToWarn", () => {
  it("rounds a part day up", () => {
    expect(daysLeftToWarn(new Date(NOW.getTime() + 2 * DAY + 1), NOW)).toBe(3);
    expect(daysLeftToWarn(new Date(NOW.getTime() + 3 * DAY), NOW)).toBe(3);
  });

  it("warns from REVIEW_EXPIRY_WARN_DAYS inclusive, not before", () => {
    expect(daysLeftToWarn(new Date(NOW.getTime() + REVIEW_EXPIRY_WARN_DAYS * DAY), NOW)).toBe(REVIEW_EXPIRY_WARN_DAYS);
    expect(daysLeftToWarn(new Date(NOW.getTime() + REVIEW_EXPIRY_WARN_DAYS * DAY + 1), NOW)).toBeUndefined();
  });

  it("says 0 rather than a negative count once it is past", () => {
    expect(daysLeftToWarn(new Date(NOW.getTime() - DAY), NOW)).toBe(0);
  });
});

describe("soonestExpiry", () => {
  it("picks the earliest, whatever the order", () => {
    const a = new Date(NOW.getTime() + DAY);
    const b = new Date(NOW.getTime() + 2 * DAY);
    expect(soonestExpiry([b, a])).toBe(a);
    expect(soonestExpiry([a, b])).toBe(a);
  });

  it("is undefined for none", () => {
    expect(soonestExpiry([])).toBeUndefined();
  });
});
