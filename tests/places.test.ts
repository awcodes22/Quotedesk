import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { buildInfoCard } from "../public/js/render/callPanel.js";
import {
  buildSearchQuery,
  describePickCount,
  describePlacesConfirm,
  formatRating,
} from "../public/js/render/places.js";
import type { JobListing } from "../public/js/render/view.js";
import { createInitialState, runReducer, selectCalls } from "../public/js/state.js";
import type { CallState, RunState } from "../public/js/state.js";
import { RunRegistry } from "../src/api/registry";
import { createApp } from "../src/app";
import type { AgentEvent, RunBusiness } from "../src/core/events";
import { getRunLogPath, startRecorder } from "../src/core/recorder";
import {
  FIELD_MASK,
  googlePlacesProvider,
  isTollFree,
  parsePlaces,
  SEARCH_URL,
} from "../src/places/googlePlaces";
import type { FetchFunction, PlaceHotel, PlacesProvider } from "../src/places/googlePlaces";
import { PlacesDirectory, PLACE_CACHE_MS, SEARCH_CACHE_MS, SEARCHES_PER_HOUR } from "../src/places/placesDirectory";
import { SAMPLE_HOTELS, samplePlacesProvider } from "../src/places/samplePlaces";
import { elevenLabsClient } from "../src/providers/elevenLabs";
import { liveProvider } from "../src/providers/live";
import type { LiveLimits } from "../src/providers/live";
import { createQuoteExtractor } from "../src/providers/quoteExtractor";
import type { CallProvider } from "../src/providers/types";

// Never a real key; the tests check it is never echoed anywhere.
const API_KEY = "test-places-key-0123456789";
const MAPLE_COURT_PHONE = "+14165550101";
const TEST_DIGITS = "4165550123";

const tempDirectories: string[] = [];
const stoppers: (() => void)[] = [];

afterEach(() => {
  for (const stop of stoppers.splice(0)) {
    stop();
  }

  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "quotedesk-places-"));
  tempDirectories.push(directory);
  return directory;
}

type RecordedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

function fakeGoogle(status: number, body: unknown, requests: RecordedRequest[] = []): FetchFunction {
  async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    let method = "GET";
    let headers: Record<string, string> = {};
    let requestBody: Record<string, unknown> = {};

    if (init !== undefined) {
      method = String(init.method);
      headers = init.headers as Record<string, string>;
      requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
    }

    requests.push({ url: String(input), method, headers, body: requestBody });
    return Response.json(body, { status });
  }

  return fakeFetch as FetchFunction;
}

const rawPlaces = {
  places: [
    {
      id: "place-intl",
      displayName: { text: "Harbour Hotel" },
      formattedAddress: "1 Example Street, Toronto, ON",
      internationalPhoneNumber: "+1 416-555-0111",
      nationalPhoneNumber: "(416) 555-0111",
      rating: 4.3,
      userRatingCount: 1200,
      priceLevel: "PRICE_LEVEL_MODERATE",
      websiteUri: "https://example.com/harbour",
      businessStatus: "OPERATIONAL",
    },
    {
      id: "place-national",
      displayName: { text: "Corner Inn" },
      formattedAddress: "2 Example Street, Toronto, ON",
      nationalPhoneNumber: "(647) 555-0112",
      businessStatus: "OPERATIONAL",
    },
    {
      id: "place-toll-free",
      displayName: { text: "Chain Hotel" },
      formattedAddress: "3 Example Street, Toronto, ON",
      internationalPhoneNumber: "+1 877-555-0113",
      businessStatus: "OPERATIONAL",
    },
    {
      id: "place-closed",
      displayName: { text: "Closed Hotel" },
      internationalPhoneNumber: "+1 416-555-0114",
      businessStatus: "CLOSED_TEMPORARILY",
    },
    {
      id: "place-no-phone",
      displayName: { text: "Quiet Hostel" },
      businessStatus: "OPERATIONAL",
    },
    {
      id: "place-abroad",
      displayName: { text: "London Hotel" },
      internationalPhoneNumber: "+44 20 5550 0115",
      businessStatus: "OPERATIONAL",
    },
  ],
};

describe("Google Places client", () => {
  it("posts a lodging text search with only the fields the dashboard shows", async () => {
    const requests: RecordedRequest[] = [];
    const provider = googlePlacesProvider({ apiKey: API_KEY, fetch: fakeGoogle(200, rawPlaces, requests) });

    await provider.search("hotels in downtown Toronto");

    const sent = requests[0];
    expect(sent).toBeDefined();
    expect(sent).toMatchObject({
      url: SEARCH_URL,
      method: "POST",
      headers: { "X-Goog-Api-Key": API_KEY, "X-Goog-FieldMask": FIELD_MASK },
      body: { textQuery: "hotels in downtown Toronto", includedType: "lodging", pageSize: 20 },
    });
    expect(FIELD_MASK).toBe(
      "places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.internationalPhoneNumber,places.rating,places.userRatingCount,places.priceLevel,places.websiteUri,places.businessStatus",
    );
  });

  it("parses hotels, normalizes phones and drops closed, phoneless and non-North-American results", () => {
    const hotels = parsePlaces(rawPlaces);

    expect(hotels.map((hotel) => [hotel.placeId, hotel.phone, hotel.tollFree])).toEqual([
      ["place-intl", "+14165550111", false],
      ["place-national", "+16475550112", false],
      ["place-toll-free", "+18775550113", true],
    ]);
    expect(hotels[0]).toEqual({
      placeId: "place-intl",
      name: "Harbour Hotel",
      address: "1 Example Street, Toronto, ON",
      phone: "+14165550111",
      rating: 4.3,
      reviewCount: 1200,
      priceLevel: "$$",
      website: "https://example.com/harbour",
      tollFree: false,
    });
  });

  it("flags every toll-free area code as central reservations", () => {
    for (const areaCode of ["800", "833", "844", "855", "866", "877", "888"]) {
      expect(isTollFree(`+1${areaCode}5550199`)).toBe(true);
    }

    expect(isTollFree("+14165550199")).toBe(false);
  });

  it("treats an empty response as no hotels", () => {
    expect(parsePlaces({})).toEqual([]);
  });

  it("refuses to start without a key", () => {
    expect(() => googlePlacesProvider({ apiKey: undefined, fetch: fakeGoogle(200, rawPlaces) })).toThrow(
      "GOOGLE_PLACES_API_KEY is not set.",
    );
  });

  it("explains 403 and quota errors without ever including the key", async () => {
    const forbidden = googlePlacesProvider({
      apiKey: API_KEY,
      fetch: fakeGoogle(403, { error: { status: "PERMISSION_DENIED", message: `API key ${API_KEY} is invalid.` } }),
    });
    const exhausted = googlePlacesProvider({
      apiKey: API_KEY,
      fetch: fakeGoogle(429, { error: { status: "RESOURCE_EXHAUSTED", message: `Quota for ${API_KEY}` } }),
    });

    const forbiddenError = await forbidden.search("hotels").catch((error: Error) => error.message);
    const quotaError = await exhausted.search("hotels").catch((error: Error) => error.message);

    expect(forbiddenError).toContain("refused the key (403)");
    expect(quotaError).toContain("quota is used up");
    expect(`${forbiddenError} ${quotaError}`).not.toContain(API_KEY);
  });
});

describe("sample hotels", () => {
  it("only uses 555-01XX numbers and drops the closed and phoneless samples", () => {
    expect(SAMPLE_HOTELS.length).toBe(7);

    for (const hotel of SAMPLE_HOTELS) {
      expect(hotel.phone).toMatch(/^\+1\d{3}55501\d{2}$/);
    }

    expect(SAMPLE_HOTELS.some((hotel) => hotel.tollFree)).toBe(true);
  });
});

function countingProvider(): { provider: PlacesProvider; calls: string[] } {
  const calls: string[] = [];

  async function search(query: string): Promise<PlaceHotel[]> {
    calls.push(query);
    return SAMPLE_HOTELS;
  }

  return { provider: { name: "google", search }, calls };
}

describe("places directory", () => {
  it("caches an identical search for 10 minutes", async () => {
    let now = 0;
    const counted = countingProvider();
    const directory = new PlacesDirectory(counted.provider, () => now);

    await directory.search("Hotels in Toronto");
    now = SEARCH_CACHE_MS - 1;
    await directory.search("  hotels   in toronto ");
    expect(counted.calls).toHaveLength(1);

    now = SEARCH_CACHE_MS + 1;
    await directory.search("hotels in toronto");
    expect(counted.calls).toHaveLength(2);
  });

  it("keeps picked hotels for 30 minutes, then refuses them as expired", async () => {
    let now = 0;
    const directory = new PlacesDirectory(countingProvider().provider, () => now);
    await directory.search("hotels");

    now = PLACE_CACHE_MS - 1;
    expect(directory.lookUp(["sample-maple-court"])).toMatchObject({ ok: true });

    now = PLACE_CACHE_MS + 1;
    const expired = directory.lookUp(["sample-maple-court"]);
    expect(expired).toMatchObject({ ok: false });
    expect(JSON.stringify(expired)).toContain("expired or is unknown");
  });

  it("refuses an id that never came from a search", () => {
    const directory = new PlacesDirectory(countingProvider().provider);

    expect(directory.lookUp(["made-up-place"])).toMatchObject({ ok: false });
  });

  it(`allows ${SEARCHES_PER_HOUR} searches an hour, without counting cached ones`, async () => {
    const counted = countingProvider();
    const directory = new PlacesDirectory(counted.provider);

    for (let index = 0; index < SEARCHES_PER_HOUR; index += 1) {
      const result = await directory.search(`hotels ${index}`);
      expect(result.ok).toBe(true);
    }

    const cached = await directory.search("hotels 0");
    const tooMany = await directory.search("hotels 99");

    expect(cached.ok).toBe(true);
    expect(tooMany).toMatchObject({ ok: false, status: 429 });
    expect(JSON.stringify(tooMany)).toContain(`Only ${SEARCHES_PER_HOUR} hotel searches are allowed per hour`);
  });
});

describe("Find hotels wording", () => {
  it("prefills the search from the job's location", () => {
    const listing = { location: "downtown Toronto" } as JobListing;

    expect(buildSearchQuery(listing)).toBe("hotels in downtown Toronto");
    expect(buildSearchQuery({ location: null } as JobListing)).toBe("hotels");
  });

  it("counts picks and confirms before calling", () => {
    expect(describePickCount(3, 6)).toBe("3 of 6 picked");
    expect(describePlacesConfirm(6)).toBe("Call 6 hotels now? QuoteDesk says it's an AI and never books.");
    expect(formatRating(4.4, 1820)).toBe("4.4 (1,820 reviews)");
  });
});

// One call that answers, says the hotel's own number out loud, and quotes.
function fakeLiveProvider(runsDirectory: string): CallProvider {
  async function fakeFetch(input: string | URL | Request): Promise<Response> {
    const url = String(input);

    if (url.endsWith("/twilio/outbound-call")) {
      return Response.json({ success: true, message: "ok", conversation_id: "conv-1", callSid: "CA1" });
    }

    if (url.endsWith("/audio")) {
      return new Response(new Uint8Array([1, 2, 3]));
    }

    const transcript = [{ role: "user", message: "It's 400. Call us back at (416) 555-0101.", time_in_call_secs: 1 }];
    return Response.json({ status: "done", transcript });
  }

  return liveProvider({
    client: elevenLabsClient({ apiKey: "k", agentId: "a", phoneNumberId: "p", fetch: fakeFetch as FetchFunction }),
    extractQuote: createQuoteExtractor(async () => JSON.stringify({ quote: { total: 400 }, notes: [] })),
    guestName: "Pat Example",
    allowedNumbers: [],
    maxCalls: 6,
    callTimeoutMs: 10_000,
    runsDirectory,
    pollMs: 5,
    spacingMs: 0,
  });
}

// No numbers on the allowlist, so a run only works because the picked hotels are approved for it.
const limits: LiveLimits = { allowedNumbers: [], maxCalls: 6, callTimeoutMs: 10_000, selfTest: true };

function buildPlacesApp(placesProvider: PlacesProvider) {
  const runsDirectory = createTempDirectory();
  const registry = new RunRegistry();
  stoppers.push(registry.start());
  stoppers.push(startRecorder(runsDirectory));

  const app = createApp({
    jobsDirectory: "data/jobs",
    runsDirectory,
    publicDirectory: "public",
    runOptions: { maxParallelCalls: 3, decisionWindowMs: 2_000, runTimeoutMs: 5_000, settleGraceMs: 10, priceFlagPct: 10 },
    maxTurns: 14,
    createProvider: () => fakeLiveProvider(runsDirectory),
    registry,
    liveLimits: limits,
    placesDirectory: new PlacesDirectory(placesProvider),
  });

  return { app, registry, runsDirectory };
}

async function waitForSummary(app: ReturnType<typeof createApp>, runId: string): Promise<request.Response> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await request(app).get(`/api/runs/${runId}/summary`);

    if (response.status === 200) {
      return response;
    }

    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }

  throw new Error("The run never finished.");
}

describe("POST /api/places/search", () => {
  it("returns hotels with every field the dashboard needs, and never the key", async () => {
    const google = googlePlacesProvider({ apiKey: API_KEY, fetch: fakeGoogle(200, rawPlaces) });
    const { app } = buildPlacesApp(google);

    const response = await request(app).post("/api/places/search").send({ query: "hotels in Toronto" });

    expect(response.status).toBe(200);
    expect(response.body.sample).toBe(false);
    expect(response.body.hotels[0]).toEqual({
      placeId: "place-intl",
      name: "Harbour Hotel",
      address: "1 Example Street, Toronto, ON",
      phone: "+14165550111",
      rating: 4.3,
      reviewCount: 1200,
      priceLevel: "$$",
      website: "https://example.com/harbour",
      tollFree: false,
    });
    expect(response.text).not.toContain(API_KEY);
  });

  it("never returns the key in an error either", async () => {
    const google = googlePlacesProvider({
      apiKey: API_KEY,
      fetch: fakeGoogle(403, { error: { status: "PERMISSION_DENIED", message: `Key ${API_KEY} refused` } }),
    });
    const { app } = buildPlacesApp(google);

    const response = await request(app).post("/api/places/search").send({ query: "hotels" });

    expect(response.status).toBe(502);
    expect(response.body.error).toContain("403");
    expect(response.text).not.toContain(API_KEY);
  });

  it("says when sample hotels stand in for Google Places", async () => {
    const { app } = buildPlacesApp(samplePlacesProvider());

    const response = await request(app).post("/api/places/search").send({ query: "hotels" });

    expect(response.body.sample).toBe(true);
    expect(response.body.hotels).toHaveLength(7);
  });
});

describe("live runs from picked hotels", () => {
  it("refuses more hotels than LIVE_MAX_CALLS", async () => {
    const { app } = buildPlacesApp(samplePlacesProvider());
    await request(app).post("/api/places/search").send({ query: "hotels" });
    const sevenIds = SAMPLE_HOTELS.map((hotel) => hotel.placeId);

    const response = await request(app)
      .post("/api/runs")
      .send({ jobId: "toronto-weekend", provider: "live", placeIds: sevenIds });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Pick between 1 and 6 hotels.");
  });

  it("refuses expired or unknown hotels with a clear error", async () => {
    const { app } = buildPlacesApp(samplePlacesProvider());

    const response = await request(app)
      .post("/api/runs")
      .send({ jobId: "toronto-weekend", provider: "live", placeIds: ["sample-maple-court"] });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("expired or is unknown. Search again");
  });

  it("calls the picked hotels on a committed job, past an empty allowlist, and keeps their public numbers", async () => {
    const { app, registry, runsDirectory } = buildPlacesApp(samplePlacesProvider());
    await request(app).post("/api/places/search").send({ query: "hotels in downtown Toronto" });

    const started = await request(app)
      .post("/api/runs")
      .send({ jobId: "toronto-weekend", provider: "live", placeIds: ["sample-maple-court", "sample-lakeview-suites"] });
    expect(started.status).toBe(201);

    const summary = await waitForSummary(app, started.body.runId);
    let events: AgentEvent[] = [];
    const recorded = registry.getEvents(started.body.runId);

    if (recorded !== undefined) {
      events = recorded;
    }

    const runStarted = events.find((event) => event.type === "run_started");
    const logText = readFileSync(getRunLogPath(runsDirectory, started.body.runId), "utf8");

    expect(runStarted).toMatchObject({
      businesses: [
        { name: "Maple Court Hotel", publicListing: { placeId: "sample-maple-court", phone: MAPLE_COURT_PHONE } },
        { name: "Lakeview Suites", publicListing: { placeId: "sample-lakeview-suites", phone: "+14165550102" } },
      ],
    });
    expect(summary.body.counts).toMatchObject({ calls: 2, quoted: 2 });
    expect(logText).toContain(MAPLE_COURT_PHONE);
    // Free text is still masked, even when it repeats a public number.
    const transcriptText = JSON.stringify(events.filter((event) => event.type === "transcript"));
    expect(transcriptText).toContain("+1 ••• ••• ••01");
    expect(transcriptText).not.toContain("555-0101");
  });
});

function reduceAll(events: AgentEvent[]): RunState {
  let state = createInitialState();

  for (const event of events) {
    state = runReducer(state, event);
  }

  return state;
}

function onlyCall(state: RunState): CallState {
  const call = selectCalls(state)[0];

  if (call === undefined) {
    throw new Error("Expected one call.");
  }

  return call;
}

function startedWith(business: RunBusiness): AgentEvent {
  return {
    type: "run_started",
    runId: "run-info",
    at: 0,
    job: { id: "toronto-weekend", industryId: "hotels", title: "2 nights", request: "a room" },
    industryLabel: "Hotel rooms",
    provider: "live",
    businesses: [business],
  };
}

describe("call panel info card", () => {
  it("shows a Places hotel's full number as a tel: link, its address, rating and website", () => {
    const hotel = SAMPLE_HOTELS[0];

    if (hotel === undefined) {
      throw new Error("Expected a sample hotel.");
    }

    const { name, ...listing } = hotel;
    const state = reduceAll([startedWith({ id: "maple-court-hotel-1", name, publicListing: listing })]);

    expect(buildInfoCard(onlyCall(state))).toEqual({
      name: "Maple Court Hotel",
      address: "120 Example Street, Toronto, ON M5V 0A1, Canada",
      phone: "+1 416-555-0101",
      phoneHref: "tel:+14165550101",
      rating: "4.4 (1,820 reviews)",
      website: "https://example.com/maple-court",
    });
  });

  it("has no info card for a test call, which only ever shows its masked number", () => {
    const state = reduceAll([startedWith({ id: "test-call", name: "Test call", maskedPhone: "+1 ••• ••• ••23" })]);
    const call = onlyCall(state);

    expect(buildInfoCard(call)).toBeNull();
    expect(call.maskedPhone).toBe("+1 ••• ••• ••23");
    expect(JSON.stringify(state)).not.toContain(TEST_DIGITS);
  });
});
