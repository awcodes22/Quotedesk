import { parsePlaces } from "./googlePlaces";
import type { PlaceHotel, PlacesProvider } from "./googlePlaces";

// Made-up hotels with numbers reserved for fiction (555-0100 to 555-0199), shaped like a real
// Places response so they go through the same parsing and filtering. Two are dropped on purpose:
// one is closed and one has no phone.
const SAMPLE_RESPONSE = {
  places: [
    {
      id: "sample-maple-court",
      displayName: { text: "Maple Court Hotel" },
      formattedAddress: "120 Example Street, Toronto, ON M5V 0A1, Canada",
      internationalPhoneNumber: "+1 416-555-0101",
      rating: 4.4,
      userRatingCount: 1820,
      priceLevel: "PRICE_LEVEL_MODERATE",
      websiteUri: "https://example.com/maple-court",
      businessStatus: "OPERATIONAL",
    },
    {
      id: "sample-lakeview-suites",
      displayName: { text: "Lakeview Suites" },
      formattedAddress: "45 Sample Quay, Toronto, ON M5J 0A2, Canada",
      internationalPhoneNumber: "+1 416-555-0102",
      rating: 4.1,
      userRatingCount: 960,
      priceLevel: "PRICE_LEVEL_EXPENSIVE",
      websiteUri: "https://example.com/lakeview",
      businessStatus: "OPERATIONAL",
    },
    {
      id: "sample-king-street-inn",
      displayName: { text: "King Street Inn" },
      formattedAddress: "300 Placeholder Ave W, Toronto, ON M5V 0A3, Canada",
      nationalPhoneNumber: "(416) 555-0103",
      rating: 3.9,
      userRatingCount: 412,
      priceLevel: "PRICE_LEVEL_INEXPENSIVE",
      businessStatus: "OPERATIONAL",
    },
    {
      id: "sample-grand-central-stay",
      displayName: { text: "Grand Central Stay" },
      formattedAddress: "8 Demo Plaza, Toronto, ON M5H 0A4, Canada",
      internationalPhoneNumber: "+1 888-555-0142",
      rating: 4.2,
      userRatingCount: 3105,
      priceLevel: "PRICE_LEVEL_MODERATE",
      websiteUri: "https://example.com/grand-central",
      businessStatus: "OPERATIONAL",
    },
    {
      id: "sample-distillery-lofts",
      displayName: { text: "Distillery Lofts" },
      formattedAddress: "55 Test Lane, Toronto, ON M5A 0A5, Canada",
      internationalPhoneNumber: "+1 647-555-0104",
      rating: 4.6,
      userRatingCount: 288,
      priceLevel: "PRICE_LEVEL_EXPENSIVE",
      websiteUri: "https://example.com/distillery-lofts",
      businessStatus: "OPERATIONAL",
    },
    {
      id: "sample-queens-quay-hotel",
      displayName: { text: "Queens Quay Hotel" },
      formattedAddress: "200 Mock Boulevard, Toronto, ON M5J 0A6, Canada",
      internationalPhoneNumber: "+1 416-555-0105",
      rating: 4.0,
      userRatingCount: 1530,
      businessStatus: "OPERATIONAL",
    },
    {
      id: "sample-yorkville-house",
      displayName: { text: "Yorkville House" },
      formattedAddress: "18 Sample Road, Toronto, ON M5R 0A7, Canada",
      internationalPhoneNumber: "+1 416-555-0106",
      rating: 4.7,
      userRatingCount: 640,
      priceLevel: "PRICE_LEVEL_VERY_EXPENSIVE",
      websiteUri: "https://example.com/yorkville-house",
      businessStatus: "OPERATIONAL",
    },
    {
      id: "sample-old-station-hotel",
      displayName: { text: "Old Station Hotel" },
      formattedAddress: "9 Closed Court, Toronto, ON M5T 0A8, Canada",
      internationalPhoneNumber: "+1 416-555-0107",
      businessStatus: "CLOSED_PERMANENTLY",
    },
    {
      id: "sample-no-phone-hostel",
      displayName: { text: "No Phone Hostel" },
      formattedAddress: "77 Quiet Street, Toronto, ON M6J 0A9, Canada",
      businessStatus: "OPERATIONAL",
    },
  ],
};

export const SAMPLE_HOTELS: PlaceHotel[] = parsePlaces(SAMPLE_RESPONSE);

// The same sample list for every query, since it only stands in until a key is set.
export function samplePlacesProvider(): PlacesProvider {
  async function search(): Promise<PlaceHotel[]> {
    return SAMPLE_HOTELS;
  }

  return { name: "sample", search };
}
