import { HourlyLimiter } from "../api/hourlyLimiter";
import { describeError } from "../privacy";
import type { AreaSuggestion, PlaceHotel, PlacesProvider } from "./googlePlaces";

export const SEARCHES_PER_HOUR = 20;
// Autocomplete runs as people type, so it gets its own, larger budget instead of eating the searches.
export const AUTOCOMPLETES_PER_HOUR = 100;
export const MIN_AUTOCOMPLETE_LENGTH = 2;
export const SEARCH_CACHE_MS = 10 * 60 * 1000;
export const PLACE_CACHE_MS = 30 * 60 * 1000;

export type SearchResult =
  | { ok: true; hotels: PlaceHotel[]; sample: boolean }
  | { ok: false; status: 400 | 429 | 502; error: string };

export type LookUpResult = { ok: true; hotels: PlaceHotel[] } | { ok: false; error: string };

export type AutocompleteResult =
  | { ok: true; suggestions: AreaSuggestion[]; sample: boolean }
  | { ok: false; status: 429 | 502; error: string };

type Cached<Value> = {
  value: Value;
  expiresAt: number;
};

const MAX_QUERY_LENGTH = 200;

function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

// Searches are cached and limited, because each one is billed; a picked hotel is only trusted
// for half an hour after it was found, so a run always dials a recent listing.
export class PlacesDirectory {
  private readonly provider: PlacesProvider;
  private readonly now: () => number;
  private readonly limiter: HourlyLimiter;
  private readonly autocompleteLimiter: HourlyLimiter;
  private readonly searches = new Map<string, Cached<PlaceHotel[]>>();
  private readonly places = new Map<string, Cached<PlaceHotel>>();
  private readonly suggestions = new Map<string, Cached<AreaSuggestion[]>>();

  constructor(provider: PlacesProvider, now: () => number = Date.now) {
    this.provider = provider;
    this.now = now;
    this.limiter = new HourlyLimiter(SEARCHES_PER_HOUR, now);
    this.autocompleteLimiter = new HourlyLimiter(AUTOCOMPLETES_PER_HOUR, now);
  }

  async autocomplete(input: string): Promise<AutocompleteResult> {
    const key = normalizeQuery(input);

    if (key.length < MIN_AUTOCOMPLETE_LENGTH || key.length > MAX_QUERY_LENGTH) {
      return { ok: true, suggestions: [], sample: this.isSample };
    }

    const cached = this.readFresh(this.suggestions.get(key));

    if (cached !== undefined) {
      return { ok: true, suggestions: cached, sample: this.isSample };
    }

    const slot = this.autocompleteLimiter.take();

    if (slot.ok === false) {
      return {
        ok: false,
        status: 429,
        error: `Too many area lookups this hour. Type the area in full, or try again in ${slot.waitMinutes} minutes.`,
      };
    }

    try {
      const suggestions = await this.provider.autocomplete(input.trim());
      this.suggestions.set(key, { value: suggestions, expiresAt: this.now() + SEARCH_CACHE_MS });
      return { ok: true, suggestions, sample: this.isSample };
    } catch (error) {
      return { ok: false, status: 502, error: describeError(error) };
    }
  }

  get isSample(): boolean {
    return this.provider.name === "sample";
  }

  async search(query: string): Promise<SearchResult> {
    const key = normalizeQuery(query);

    if (key === "" || key.length > MAX_QUERY_LENGTH) {
      return { ok: false, status: 400, error: `Enter a search of 1 to ${MAX_QUERY_LENGTH} characters.` };
    }

    const cached = this.readFresh(this.searches.get(key));

    if (cached !== undefined) {
      this.remember(cached);
      return { ok: true, hotels: cached, sample: this.isSample };
    }

    return this.searchProvider(key, query.trim());
  }

  lookUp(placeIds: string[]): LookUpResult {
    const hotels: PlaceHotel[] = [];

    for (const placeId of placeIds) {
      const hotel = this.readFresh(this.places.get(placeId));

      if (hotel === undefined) {
        return {
          ok: false,
          error: "One of the picked hotels has expired or is unknown. Search again and pick it from the new results.",
        };
      }

      hotels.push(hotel);
    }

    return { ok: true, hotels };
  }

  private async searchProvider(key: string, query: string): Promise<SearchResult> {
    const slot = this.limiter.take();

    if (slot.ok === false) {
      return {
        ok: false,
        status: 429,
        error: `Only ${SEARCHES_PER_HOUR} hotel searches are allowed per hour. Try again in ${slot.waitMinutes} minutes.`,
      };
    }

    try {
      const hotels = await this.provider.search(query);
      this.searches.set(key, { value: hotels, expiresAt: this.now() + SEARCH_CACHE_MS });
      this.remember(hotels);
      return { ok: true, hotels, sample: this.isSample };
    } catch (error) {
      return { ok: false, status: 502, error: describeError(error) };
    }
  }

  private remember(hotels: PlaceHotel[]): void {
    const expiresAt = this.now() + PLACE_CACHE_MS;

    for (const hotel of hotels) {
      this.places.set(hotel.placeId, { value: hotel, expiresAt });
    }
  }

  private readFresh<Value>(entry: Cached<Value> | undefined): Value | undefined {
    if (entry === undefined || entry.expiresAt <= this.now()) {
      return undefined;
    }

    return entry.value;
  }
}
