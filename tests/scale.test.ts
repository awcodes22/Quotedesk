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

  it("jitters clone prices but keeps a drop a drop", () => {
    const scaled = scaleRun(job, hotels, 120);
    const clones = scaled.industry.simBusinesses.slice(3);
    const totals = clones.flatMap((clone) => clone.fakeQuotes.map((quote) => quote.total));

    expect(Math.min(...totals)).toBeGreaterThanOrEqual(Math.floor(398 * 0.97));
    expect(Math.max(...totals)).toBeLessThanOrEqual(Math.ceil(455 * 1.17));
    expect(new Set(totals).size).toBeGreaterThan(20);

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
