import { z } from "zod";
import { normalizeNorthAmericanNumber } from "../privacy";

export type FetchFunction = typeof fetch;

export type PlaceHotel = {
  placeId: string;
  name: string;
  address: string;
  phone: string;
  rating: number | null;
  reviewCount: number | null;
  priceLevel: string | null;
  website: string | null;
  tollFree: boolean;
};

export type AreaSuggestion = {
  text: string;
  main: string;
  secondary: string;
};

export type PlacesProvider = {
  // "sample" means Google Places isn't set up and the hotels are made up.
  name: "google" | "sample";
  search: (query: string) => Promise<PlaceHotel[]>;
  autocomplete: (input: string) => Promise<AreaSuggestion[]>;
};

export const SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
export const AUTOCOMPLETE_URL = "https://places.googleapis.com/v1/places:autocomplete";
export const AUTOCOMPLETE_FIELD_MASK = "suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat";
export const MAX_RESULTS = 20;

// Only what the dashboard shows, which also keeps each search in the cheaper billing tier.
export const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.nationalPhoneNumber",
  "places.internationalPhoneNumber",
  "places.rating",
  "places.userRatingCount",
  "places.priceLevel",
  "places.websiteUri",
  "places.businessStatus",
].join(",");

const REQUEST_TIMEOUT_MS = 15_000;

// Calls to these go to a chain's central line, not the front desk.
const TOLL_FREE_AREA_CODES = ["800", "833", "844", "855", "866", "877", "888"];

const PRICE_LEVELS: Record<string, string | null> = {
  PRICE_LEVEL_UNSPECIFIED: null,
  PRICE_LEVEL_FREE: null,
  PRICE_LEVEL_INEXPENSIVE: "$",
  PRICE_LEVEL_MODERATE: "$$",
  PRICE_LEVEL_EXPENSIVE: "$$$",
  PRICE_LEVEL_VERY_EXPENSIVE: "$$$$",
};

const placeSchema = z.object({
  id: z.string().min(1),
  displayName: z.object({ text: z.string() }).optional(),
  formattedAddress: z.string().optional(),
  nationalPhoneNumber: z.string().optional(),
  internationalPhoneNumber: z.string().optional(),
  rating: z.number().optional(),
  userRatingCount: z.number().int().optional(),
  priceLevel: z.string().optional(),
  websiteUri: z.string().optional(),
  businessStatus: z.string().optional(),
});

// Google leaves out "places" entirely when nothing matched.
const searchResponseSchema = z.object({
  places: z.array(placeSchema).optional(),
});

const errorResponseSchema = z.object({
  error: z.object({ status: z.string().optional() }).optional(),
});

type Place = z.infer<typeof placeSchema>;

function nullWhenMissing<Value>(value: Value | undefined): Value | null {
  if (value === undefined) {
    return null;
  }

  return value;
}

// The international form is preferred; the national one gets +1 added if it is North American.
function readPhone(place: Place): string | null {
  const candidates = [place.internationalPhoneNumber, place.nationalPhoneNumber];

  for (const candidate of candidates) {
    if (candidate !== undefined) {
      const phone = normalizeNorthAmericanNumber(candidate);

      if (phone !== null) {
        return phone;
      }
    }
  }

  return null;
}

export function isTollFree(phone: string): boolean {
  const areaCode = phone.slice(2, 5);
  return TOLL_FREE_AREA_CODES.includes(areaCode);
}

function readPriceLevel(priceLevel: string | undefined): string | null {
  if (priceLevel === undefined) {
    return null;
  }

  const symbols = PRICE_LEVELS[priceLevel];

  if (symbols === undefined) {
    return null;
  }

  return symbols;
}

function toHotel(place: Place, phone: string): PlaceHotel {
  let name = place.id;
  let address = "";

  if (place.displayName !== undefined && place.displayName.text.trim() !== "") {
    name = place.displayName.text.trim();
  }

  if (place.formattedAddress !== undefined) {
    address = place.formattedAddress;
  }

  return {
    placeId: place.id,
    name,
    address,
    phone,
    rating: nullWhenMissing(place.rating),
    reviewCount: nullWhenMissing(place.userRatingCount),
    priceLevel: readPriceLevel(place.priceLevel),
    website: nullWhenMissing(place.websiteUri),
    tollFree: isTollFree(phone),
  };
}

// A hotel QuoteDesk can't phone is no use: closed, no number, or a number outside North America.
export function parsePlaces(raw: unknown): PlaceHotel[] {
  const response = searchResponseSchema.parse(raw);
  const hotels: PlaceHotel[] = [];
  let places: Place[] = [];

  if (response.places !== undefined) {
    places = response.places;
  }

  for (const place of places) {
    const phone = readPhone(place);
    const isOpen = place.businessStatus === "OPERATIONAL";

    if (phone !== null && isOpen) {
      hotels.push(toHotel(place, phone));
    }
  }

  return hotels.slice(0, MAX_RESULTS);
}

export function buildSearchBody(query: string): Record<string, unknown> {
  return {
    textQuery: query,
    includedType: "lodging",
    strictTypeFiltering: true,
    pageSize: MAX_RESULTS,
  };
}

// "(regions)" covers cities, neighbourhoods and areas, which is what "City or area" asks for.
export function buildAutocompleteBody(input: string): Record<string, unknown> {
  return { input, includedPrimaryTypes: ["(regions)"] };
}

const suggestionSchema = z.object({
  placePrediction: z
    .object({
      text: z.object({ text: z.string() }),
      structuredFormat: z
        .object({
          mainText: z.object({ text: z.string() }),
          secondaryText: z.object({ text: z.string() }).optional(),
        })
        .optional(),
    })
    .optional(),
});

const autocompleteResponseSchema = z.object({
  suggestions: z.array(suggestionSchema).optional(),
});

const MAX_SUGGESTIONS = 5;

export function parseSuggestions(raw: unknown): AreaSuggestion[] {
  const response = autocompleteResponseSchema.parse(raw);
  const suggestions: AreaSuggestion[] = [];
  let items: z.infer<typeof suggestionSchema>[] = [];

  if (response.suggestions !== undefined) {
    items = response.suggestions;
  }

  for (const item of items) {
    const prediction = item.placePrediction;

    if (prediction !== undefined) {
      let main = prediction.text.text;
      let secondary = "";

      if (prediction.structuredFormat !== undefined) {
        main = prediction.structuredFormat.mainText.text;

        if (prediction.structuredFormat.secondaryText !== undefined) {
          secondary = prediction.structuredFormat.secondaryText.text;
        }
      }

      suggestions.push({ text: prediction.text.text, main, secondary });
    }
  }

  return suggestions.slice(0, MAX_SUGGESTIONS);
}

async function readErrorStatus(response: Response): Promise<string | undefined> {
  try {
    const parsed = errorResponseSchema.safeParse(await response.json());

    if (parsed.success && parsed.data.error !== undefined) {
      return parsed.data.error.status;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

// Google's own message can quote the request, so only its status code is passed on, never the key.
async function describeFailure(response: Response): Promise<Error> {
  const status = await readErrorStatus(response);

  if (response.status === 429 || status === "RESOURCE_EXHAUSTED") {
    return new Error("Google Places quota is used up for now. Try again later.");
  }

  if (response.status === 403 || status === "PERMISSION_DENIED") {
    return new Error(
      "Google Places refused the key (403). Check that the Places API (New) is enabled for it and that it isn't restricted.",
    );
  }

  return new Error(`Google Places search failed with HTTP ${response.status}.`);
}

export type GooglePlacesSettings = {
  apiKey: string | undefined;
  fetch: FetchFunction;
};

export function googlePlacesProvider(settings: GooglePlacesSettings): PlacesProvider {
  const apiKey = settings.apiKey;

  if (apiKey === undefined || apiKey.trim() === "") {
    throw new Error("GOOGLE_PLACES_API_KEY is not set.");
  }

  async function post(url: string, fieldMask: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await settings.fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": String(apiKey),
        "X-Goog-FieldMask": fieldMask,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.ok === false) {
      throw await describeFailure(response);
    }

    return response.json();
  }

  async function search(query: string): Promise<PlaceHotel[]> {
    return parsePlaces(await post(SEARCH_URL, FIELD_MASK, buildSearchBody(query)));
  }

  async function autocomplete(input: string): Promise<AreaSuggestion[]> {
    return parseSuggestions(await post(AUTOCOMPLETE_URL, AUTOCOMPLETE_FIELD_MASK, buildAutocompleteBody(input)));
  }

  return { name: "google", search, autocomplete };
}
