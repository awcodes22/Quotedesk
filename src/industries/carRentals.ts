import { z } from "zod";
import type {
  IndustryConfig,
  Quote,
  QuoteFields,
  SimBusiness,
} from "../core/types";

const lineSchema = z.object({
  item: z.string(),
  unitPrice: z.number().positive(),
});

const quoteSchema = z.object({
  total: z
    .number()
    .positive()
    .describe("The total for the whole rental with insurance and fees"),
  unlimitedMileage: z
    .boolean()
    .optional()
    .describe("Whether the rental has unlimited mileage"),
  lines: z
    .array(lineSchema)
    .optional()
    .describe(
      'Per-day or flat prices, such as "daily rate", "insurance per day" or "airport fee"',
    ),
});

function preferUnlimitedMileage(a: Quote, b: Quote): number {
  const aIsUnlimited = a.fields.unlimitedMileage === true;
  const bIsUnlimited = b.fields.unlimitedMileage === true;

  if (aIsUnlimited === bIsUnlimited) {
    return 0;
  }

  if (aIsUnlimited) {
    return -1;
  }

  return 1;
}

function getLinePrices(fields: QuoteFields): Record<string, number> {
  // QuoteFields types extra fields as unknown, so parsing restores the type of lines.
  const quote = quoteSchema.parse(fields);
  const prices: Record<string, number> = {};

  if (quote.lines === undefined) {
    return prices;
  }

  for (const line of quote.lines) {
    prices[line.item] = line.unitPrice;
  }

  return prices;
}

function buildInstructions(businessName: string, details: string): string {
  const role = `You work the rental counter at ${businessName}.`;
  const manner =
    "Give the total for the rental when asked, and break it down if asked.";
  return `${role} ${manner} ${details}`;
}

const northwayRentals: SimBusiness = {
  id: "northway-rentals",
  name: "Northway Rentals",
  instructions: buildInstructions(
    "Northway Rentals",
    "The daily rate is $58, insurance is $22 a day, and the airport fee is $35 flat. The total for 3 days is $275. Mileage is unlimited. No discounts.",
  ),
  fakeQuotes: [
    {
      total: 275,
      unlimitedMileage: true,
      lines: [
        { item: "daily rate", unitPrice: 58 },
        { item: "insurance per day", unitPrice: 22 },
        { item: "airport fee", unitPrice: 35 },
      ],
    },
  ],
};

const metroDrive: SimBusiness = {
  id: "metro-drive",
  name: "Metro Drive",
  instructions: buildInstructions(
    "Metro Drive",
    "The daily rate is $64, insurance is $19 a day, and the airport fee is $30. The total for 3 days is $279. If asked for a better rate, drop the daily rate to $52, making the total $243. Mileage is capped at 200 km a day.",
  ),
  fakeQuotes: [
    {
      total: 279,
      unlimitedMileage: false,
      lines: [
        { item: "daily rate", unitPrice: 64 },
        { item: "insurance per day", unitPrice: 19 },
        { item: "airport fee", unitPrice: 30 },
      ],
    },
    {
      total: 243,
      unlimitedMileage: false,
      lines: [
        { item: "daily rate", unitPrice: 52 },
        { item: "insurance per day", unitPrice: 19 },
        { item: "airport fee", unitPrice: 30 },
      ],
    },
  ],
};

const harbourfrontCarRentals: SimBusiness = {
  id: "harbourfront-car-rentals",
  name: "Harbourfront Car Rentals",
  instructions: buildInstructions(
    "Harbourfront Car Rentals",
    "The daily rate is $55, insurance is $25 a day, and there is no airport fee. The total for 3 days is $240. Mileage is unlimited.",
  ),
  fakeQuotes: [
    {
      total: 240,
      unlimitedMileage: true,
      lines: [
        { item: "daily rate", unitPrice: 55 },
        { item: "insurance per day", unitPrice: 25 },
      ],
    },
  ],
};

export const carRentals: IndustryConfig = {
  id: "car-rentals",
  label: "Car rentals",
  clientNoun: "a traveller",
  goal: "Get the daily rate, the insurance cost per day, any fees, the total for the rental, and whether mileage is unlimited.",
  quoteSchema,
  followUps: [
    "Is mileage unlimited?",
    "Are there any airport or young driver fees?",
    "What's the fuel policy?",
  ],
  commitInstruction:
    "Say the traveller would like to reserve the car at that rate, and ask them to email the confirmation.",
  tieBreak: preferUnlimitedMileage,
  linePrices: getLinePrices,
  fieldLabels: {
    unlimitedMileage: { yes: "unlimited mileage", no: "limited mileage" },
  },
  simBusinesses: [northwayRentals, metroDrive, harbourfrontCarRentals],
};
