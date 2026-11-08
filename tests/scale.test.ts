import { describe, expect, it } from "vitest";
import { hotels } from "../src/industries/hotels";
import { loadJob } from "../src/jobs";
import { MAX_SCALE, scaleRun } from "../src/scale";

const job = loadJob("data/jobs/hotels.json");

describe("scaleRun", () => {
  it("fills up to the size with uniquely named clones", () => {
    const scaled = scaleRun(job, hotels, 120);
    const businesses = scaled.industry.simBusinesses;

    expect(businesses).toHaveLength(120);
    expect(new Set(businesses.map((business) => business.id)).size).toBe(120);
    expect(new Set(businesses.map((business) => business.name)).size).toBe(120);
  });

  it("keeps the real businesses first and unchanged", () => {
    const scaled = scaleRun(job, hotels, 10);

    expect(scaled.industry.simBusinesses.slice(0, 3)).toEqual(hotels.simBusinesses);
  });

  it("jitters final prices around the real ones", () => {
    const scaled = scaleRun(job, hotels, 120);
    const clones = scaled.industry.simBusinesses.slice(3);
    const finals = clones.flatMap((clone) => clone.fakeQuotes.slice(-1));
    const totals = finals.map((quote) => quote.total);

    expect(Math.min(...totals)).toBeGreaterThanOrEqual(Math.floor(398 * 0.97));
    expect(Math.max(...totals)).toBeLessThanOrEqual(Math.ceil(455 * 1.17));
    expect(new Set(totals).size).toBeGreaterThan(20);
  });

  it("mixes terms across clones instead of copying one business", () => {
    const scaled = scaleRun(job, hotels, 120);
    const finals = scaled.industry.simBusinesses
      .slice(3)
      .flatMap((clone) => clone.fakeQuotes.slice(-1));
    const refundable = finals.filter((quote) => quote.freeCancellation === true);
    const nonRefundable = finals.filter((quote) => quote.freeCancellation === false);

    expect(refundable.length).toBeGreaterThan(nonRefundable.length);
    expect(nonRefundable.length).toBeGreaterThan(0);
  });

  it("drops the price on only about a fifth of the quoting clones", () => {
    const scaled = scaleRun(job, hotels, 120);
    const quoting = scaled.industry.simBusinesses
      .slice(3)
      .filter((clone) => clone.fakeQuotes.length > 0);
    const dropping = quoting.filter((clone) => clone.fakeQuotes.length === 2);
    const share = dropping.length / quoting.length;

    expect(share).toBeGreaterThan(0.1);
    expect(share).toBeLessThan(0.3);
  });

  it("keeps a drop a drop", () => {
    const scaled = scaleRun(job, hotels, 120);
    const clones = scaled.industry.simBusinesses.slice(3);

    for (const clone of clones.filter((business) => business.fakeQuotes.length === 2)) {
      const totals = clone.fakeQuotes.map((quote) => quote.total);
      expect(totals[1]).toBeLessThan(Number(totals[0]));
    }
  });

  it("mixes in calls that never answer and calls that never quote", () => {
    const scaled = scaleRun(job, hotels, 120);
    const silent = scaled.industry.simBusinesses.filter(
      (business) => business.fakeQuotes.length === 0,
    );

    expect(scaled.noAnswerIds.length).toBeGreaterThan(0);
    expect(silent.length).toBeGreaterThan(0);
  });

  it("gives the same demo every time", () => {
    expect(scaleRun(job, hotels, 60)).toEqual(scaleRun(job, hotels, 60));
  });

  it("takes only the first businesses when the size is small", () => {
    const scaled = scaleRun(job, hotels, 2);

    expect(scaled.industry.simBusinesses.map((business) => business.id)).toEqual([
      "harbour-inn",
      "queen-west-suites",
    ]);
  });

  it("refuses sizes outside 1 to the maximum", () => {
    expect(() => scaleRun(job, hotels, 0)).toThrow();
    expect(() => scaleRun(job, hotels, MAX_SCALE + 1)).toThrow();
    expect(() => scaleRun(job, hotels, 2.5)).toThrow();
  });
});
