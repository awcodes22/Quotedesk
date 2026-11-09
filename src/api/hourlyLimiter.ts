const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export type HourlySlot = { ok: true } | { ok: false; waitMinutes: number };

// Kept in memory on purpose: a restart resets it, and nothing about what was counted is written down.
export class HourlyLimiter {
  private readonly now: () => number;
  private readonly limit: number;
  private startTimes: number[] = [];

  constructor(limit: number, now: () => number = Date.now) {
    this.now = now;
    this.limit = limit;
  }

  take(): HourlySlot {
    const now = this.now();
    this.startTimes = this.startTimes.filter((startedAt) => now - startedAt < HOUR_MS);

    const oldest = this.startTimes[0];

    if (this.startTimes.length >= this.limit && oldest !== undefined) {
      const waitMinutes = Math.ceil((oldest + HOUR_MS - now) / MINUTE_MS);
      return { ok: false, waitMinutes };
    }

    this.startTimes.push(now);
    return { ok: true };
  }
}
