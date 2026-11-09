import { maskPhone, normalizeNorthAmericanNumber } from "../privacy";
import { HourlyLimiter } from "./hourlyLimiter";

export const SELF_TEST_RUNS_PER_HOUR = 3;
export const SELF_TEST_NAME = "Test call";

export type SelfTestNumber = { ok: true; phone: string } | { ok: false; error: string };

export type LimiterResult = { ok: true } | { ok: false; error: string };

// The error never repeats what was typed, only its masked form.
export function readSelfTestNumber(input: string): SelfTestNumber {
  const phone = normalizeNorthAmericanNumber(input);

  if (phone === null) {
    const masked = maskPhone(input);
    return {
      ok: false,
      error: `${masked} is not a North American number. Enter 10 digits, with or without +1.`,
    };
  }

  return { ok: true, phone };
}

// Kept in memory on purpose: nothing about a test number is ever written down, not even when it was used.
export class SelfTestLimiter {
  private readonly limit: number;
  private readonly limiter: HourlyLimiter;

  constructor(now: () => number = Date.now, limit: number = SELF_TEST_RUNS_PER_HOUR) {
    this.limit = limit;
    this.limiter = new HourlyLimiter(limit, now);
  }

  take(): LimiterResult {
    const slot = this.limiter.take();

    if (slot.ok === false) {
      return {
        ok: false,
        error: `Only ${this.limit} test calls are allowed per hour. Try again in ${slot.waitMinutes} minutes.`,
      };
    }

    return { ok: true };
  }
}
