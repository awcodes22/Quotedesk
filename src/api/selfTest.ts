import { maskPhone, normalizeNorthAmericanNumber } from "../privacy";

export const SELF_TEST_RUNS_PER_HOUR = 3;
export const SELF_TEST_NAME = "Test call";

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

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
  private readonly now: () => number;
  private readonly limit: number;
  private startTimes: number[] = [];

  constructor(now: () => number = Date.now, limit: number = SELF_TEST_RUNS_PER_HOUR) {
    this.now = now;
    this.limit = limit;
  }

  take(): LimiterResult {
    const now = this.now();
    this.startTimes = this.startTimes.filter((startedAt) => now - startedAt < HOUR_MS);

    const oldest = this.startTimes[0];

    if (this.startTimes.length >= this.limit && oldest !== undefined) {
      const waitMinutes = Math.ceil((oldest + HOUR_MS - now) / MINUTE_MS);
      return {
        ok: false,
        error: `Only ${this.limit} test calls are allowed per hour. Try again in ${waitMinutes} minutes.`,
      };
    }

    this.startTimes.push(now);
    return { ok: true };
  }
}
