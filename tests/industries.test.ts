import { describe, expect, it } from "vitest";
import { z } from "zod";
import { rankQuotes } from "../src/core/headAgent";
import type { Quote, QuoteFields } from "../src/core/types";
import { carRentals } from "../src/industries/carRentals";
import { hotels } from "../src/industries/hotels";
import { getIndustry, industries } from "../src/industries/index";

const RENTAL_DAYS = 3;
const allIndustries = Object.values(industries);

function buildQuote(
  callId: string,
  receivedAt: number,
  fields: QuoteFields,
): Quote {
  return {
    callId,
    businessId: `business-${callId}`,
    total: fields.total,
    fields,
    receivedAt,
  };
}

function getCarRentalLinePrices(fields: QuoteFields): Record<string, number> {
  if (carRentals.linePrices === undefined) {
    throw new Error("Car rentals must define linePrices.");
  }

  return carRentals.linePrices(fields);
}

function isPerDayItem(item: string): boolean {
  return item === "daily rate" || item.endsWith("per day");
}

function calculateRentalTotal(linePrices: Record<string, number>): number {
  let total = 0;

  for (const [item, unitPrice] of Object.entries(linePrices)) {
    if (isPerDayItem(item)) {
      total = total + unitPrice * RENTAL_DAYS;
    } else {
      total = total + unitPrice;
    }
  }

  return total;
}

describe("sim businesses", () => {
  it("has fake quotes that pass the industry schema unchanged", () => {
    for (const industry of allIndustries) {
      for (const business of industry.simBusinesses) {
        for (const fakeQuote of business.fakeQuotes) {
          // Comparing the output catches misspelled fields, which zod strips silently.
          const parsed = industry.quoteSchema.parse(fakeQuote);
          expect(parsed).toEqual(fakeQuote);
        }
      }
    }
  });

  it("has car rental totals that match their lines", () => {
    for (const business of carRentals.simBusinesses) {
      for (const fakeQuote of business.fakeQuotes) {
        const linePrices = getCarRentalLinePrices(fakeQuote);
        const calculatedTotal = calculateRentalTotal(linePrices);

        expect(calculatedTotal).toBe(fakeQuote.total);
      }
    }
  });
});

describe("hotels", () => {
  it("prefers free cancellation on equal totals", () => {
    const earlierNonRefundable = buildQuote("a", 1, {
      total: 400,
      freeCancellation: false,
    });
    const laterRefundable = buildQuote("b", 2, {
      total: 400,
      freeCancellation: true,
    });

    const ranked = rankQuotes([earlierNonRefundable, laterRefundable], hotels);

    expect(ranked).toEqual([laterRefundable, earlierNonRefundable]);
  });
});

describe("car rentals", () => {
  it("prefers unlimited mileage on equal totals", () => {
    const earlierCapped = buildQuote("a", 1, {
      total: 250,
      unlimitedMileage: false,
    });
    const laterUnlimited = buildQuote("b", 2, {
      total: 250,
      unlimitedMileage: true,
    });

    const ranked = rankQuotes([earlierCapped, laterUnlimited], carRentals);

    expect(ranked).toEqual([laterUnlimited, earlierCapped]);
  });

  it("returns the unit prices for a quote with lines", () => {
    const linePrices = getCarRentalLinePrices({
      total: 275,
      lines: [
        { item: "daily rate", unitPrice: 58 },
        { item: "insurance per day", unitPrice: 22 },
        { item: "airport fee", unitPrice: 35 },
      ],
    });

    expect(linePrices).toEqual({
      "daily rate": 58,
      "insurance per day": 22,
      "airport fee": 35,
    });
  });

  it("returns an empty object for a quote with no lines", () => {
    const linePrices = getCarRentalLinePrices({ total: 275 });

    expect(linePrices).toEqual({});
  });
});

describe("quote schemas", () => {
  it("convert to JSON Schema with total required", () => {
    for (const industry of allIndustries) {
      const jsonSchema = z.toJSONSchema(industry.quoteSchema);

      expect(jsonSchema.required).toContain("total");
    }
  });
});

describe("getIndustry", () => {
  it("finds both industries by id", () => {
    expect(getIndustry("hotels")).toBe(hotels);
    expect(getIndustry("car-rentals")).toBe(carRentals);
  });

  it("throws an error listing the valid ids for an unknown id", () => {
    expect(() => getIndustry("boats")).toThrow(
      'Unknown industry "boats". Valid ids: hotels, car-rentals',
    );
  });

  it("doesn't match inherited object properties", () => {
    expect(() => getIndustry("constructor")).toThrow("Unknown industry");
  });
});
