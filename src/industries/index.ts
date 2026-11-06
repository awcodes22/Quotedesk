import type { IndustryConfig } from "../core/types";
import { carRentals } from "./carRentals";
import { hotels } from "./hotels";

export const industries: Record<string, IndustryConfig> = {
  [hotels.id]: hotels,
  [carRentals.id]: carRentals,
};

export function getIndustry(id: string): IndustryConfig {
  const industry = industries[id];

  // hasOwn stops ids like "constructor" from matching inherited object properties.
  if (industry === undefined || Object.hasOwn(industries, id) === false) {
    const validIds = Object.keys(industries).join(", ");
    throw new Error(`Unknown industry "${id}". Valid ids: ${validIds}`);
  }

  return industry;
}
