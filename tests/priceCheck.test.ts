import { describe, expect, it } from "vitest";
import { buildRow, runPriceCheck, sameItem } from "../src/core/priceCheck";
import type { IndustryConfig, Quote } from "../src/core/types";
import { carRentals } from "../src/industries/carRentals";
import { hotels } from "../src/industries/hotels";
import { loadJob } from "../src/jobs";

const THRESHOLD_PCT = 10;

function buildFakeQuote(
  industry: IndustryConfig,
  businessId: string,
  quoteIndex: number,
): Quote {
  const business = industry.simBusinesses.find(
    (candidate) => candidate.id === businessId,
  );

  if (business === undefined) {
    throw new Error(`No sim business named ${businessId}.`);
  }

  const fields = business.fakeQuotes[quoteIndex];

  if (fields === undefined) {
    throw new Error(`${businessId} has no fake quote ${quoteIndex}.`);
  }

  return {
    callId: `call-${businessId}`,
    businessId,
    total: fields.total,
    fields,
    receivedAt: 1,
  };
}

describe("sameItem", () => {
  it("matches when either name contains the other", () => {
    expect(sameItem("insurance", "insurance per day")).toBe(true);
    expect(sameItem("insurance per day", "insurance")).toBe(true);
  });

  it("ignores case and surrounding spaces", () => {
    expect(sameItem("  Insurance ", "insurance per day")).toBe(true);
    expect(sameItem("AIRPORT FEE", "airport fee")).toBe(true);
  });

  it("rejects unrelated names", () => {
    expect(sameItem("daily rate", "airport fee")).toBe(false);
  });

  it("never matches a blank name", () => {
    expect(sameItem("   ", "daily rate")).toBe(false);
  });
});

describe("buildRow", () => {
  it("doesn't flag a diff exactly at the threshold", () => {
    expect(buildRow("Total", 100, 110, 10)).toEqual({
      item: "Total",
      reference: 100,
      quoted: 110,
      diffPct: 10,
      flagged: false,
    });
    expect(buildRow("Total", 100, 90, 10).flagged).toBe(false);
  });

  it("doesn't let float noise flag a diff at the threshold", () => {
    expect(buildRow("Total", 98, 107.8, 10).flagged).toBe(false);
  });

  it("flags a diff above the threshold in either direction", () => {
    expect(buildRow("Total", 100, 110.1, 10).flagged).toBe(true);
    expect(buildRow("Total", 100, 89.9, 10).flagged).toBe(true);
  });

  it("flags from the rounded diff so the row matches what is shown", () => {
    const row = buildRow("Total", 1000, 1100.4, 10);

    expect(row.diffPct).toBe(10);
    expect(row.flagged).toBe(false);
  });
});

describe("runPriceCheck", () => {
  it("compares Harbourfront to the car rentals reference", () => {
    const quote = buildFakeQuote(carRentals, "harbourfront-car-rentals", 0);
    const job = loadJob("data/jobs/car-rentals.json");

    const check = runPriceCheck(
      quote,
      job.reference,
      carRentals,
      THRESHOLD_PCT,
    );

    expect(check).toEqual({
      businessId: "harbourfront-car-rentals",
      thresholdPct: THRESHOLD_PCT,
      rows: [
        {
          item: "daily rate",
          reference: 52,
          quoted: 55,
          diffPct: 5.8,
          flagged: false,
        },
        {
          item: "insurance per day",
          reference: 20,
          quoted: 25,
          diffPct: 25,
          flagged: true,
        },
        {
          item: "Total",
          reference: 246,
          quoted: 240,
          diffPct: -2.4,
          flagged: false,
        },
      ],
      flaggedCount: 1,
      source: "Last trip's receipt",
    });
  });

  it("flags the Queen West total, since hotels has no line prices", () => {
    const quote = buildFakeQuote(hotels, "queen-west-suites", 1);
    const job = loadJob("data/jobs/hotels.json");

    const check = runPriceCheck(quote, job.reference, hotels, THRESHOLD_PCT);

    expect(check).toMatchObject({
      rows: [
        {
          item: "Total",
          reference: 349,
          quoted: 398,
          diffPct: 14,
          flagged: true,
        },
      ],
      flaggedCount: 1,
    });
  });

  it("skips reference lines when the industry has no line prices", () => {
    const quote = buildFakeQuote(hotels, "harbour-inn", 0);
    const reference = { lines: { "room rate": 300 } };

    const check = runPriceCheck(quote, reference, hotels, THRESHOLD_PCT);

    expect(check).toBeUndefined();
  });

  it("returns undefined with no reference", () => {
    const quote = buildFakeQuote(hotels, "harbour-inn", 0);

    const check = runPriceCheck(quote, undefined, hotels, THRESHOLD_PCT);

    expect(check).toBeUndefined();
  });

  it("returns undefined when no lines match and there is no total", () => {
    const quote = buildFakeQuote(carRentals, "harbourfront-car-rentals", 0);
    const reference = { lines: { "airport fee": 30 } };

    const check = runPriceCheck(quote, reference, carRentals, THRESHOLD_PCT);

    expect(check).toBeUndefined();
  });
});
