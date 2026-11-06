import { z } from "zod";
import type { IndustryConfig, Quote, SimBusiness } from "../core/types";

const quoteSchema = z.object({
  total: z
    .number()
    .positive()
    .describe("The total for the whole stay with taxes and fees"),
  freeCancellation: z
    .boolean()
    .optional()
    .describe("Whether the booking can be cancelled for free"),
  includesTaxes: z
    .boolean()
    .optional()
    .describe("Whether the quoted total includes taxes and fees"),
});

function preferFreeCancellation(a: Quote, b: Quote): number {
  const aIsFree = a.fields.freeCancellation === true;
  const bIsFree = b.fields.freeCancellation === true;

  if (aIsFree === bIsFree) {
    return 0;
  }

  if (aIsFree) {
    return -1;
  }

  return 1;
}

function buildInstructions(businessName: string, details: string): string {
  const role = `You work the front desk at ${businessName}.`;
  const manner =
    "Only give the price when asked. Answer breakfast, parking and check-in questions briefly.";
  return `${role} ${manner} ${details}`;
}

const harbourInn: SimBusiness = {
  id: "harbour-inn",
  name: "Harbour Inn",
  instructions: buildInstructions(
    "Harbour Inn",
    "The total is $412 including taxes and fees. This is the best rate, with no discounts. Free cancellation up to 24 hours before. Breakfast is included.",
  ),
  fakeQuotes: [{ total: 412, freeCancellation: true, includesTaxes: true }],
};

const queenWestSuites: SimBusiness = {
  id: "queen-west-suites",
  name: "Queen West Suites",
  instructions: buildInstructions(
    "Queen West Suites",
    "The total is $455 including taxes and fees. If asked for a better rate, offer a non-refundable rate of $398. Breakfast is not included.",
  ),
  fakeQuotes: [
    { total: 455, freeCancellation: true, includesTaxes: true },
    { total: 398, freeCancellation: false, includesTaxes: true },
  ],
};

const unionStationHotel: SimBusiness = {
  id: "union-station-hotel",
  name: "Union Station Hotel",
  instructions: buildInstructions(
    "Union Station Hotel",
    "The total is $430 including taxes and fees. This is the best rate. Free cancellation. You are chatty and like to mention the rooftop bar.",
  ),
  fakeQuotes: [{ total: 430, freeCancellation: true, includesTaxes: true }],
};

export const hotels: IndustryConfig = {
  id: "hotels",
  label: "Hotel rooms",
  clientNoun: "a guest",
  goal: "Get the total for the stay including taxes and fees, and whether cancellation is free.",
  quoteSchema,
  followUps: [
    "Does that include all taxes and fees?",
    "What is the cancellation policy?",
    "Is breakfast included?",
  ],
  commitInstruction:
    "Say you'd like to book the room at that rate, and ask them to email the confirmation.",
  tieBreak: preferFreeCancellation,
  simBusinesses: [harbourInn, queenWestSuites, unionStationHotel],
};
