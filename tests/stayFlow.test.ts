import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { listCallableHotels, pickTop } from "../public/js/flow/hotelList.js";
import {
  buildSampleStay,
  buildStayPayload,
  createWizardState,
  describeAgentAsks,
  isStepValid,
  STEPS,
  summarizeStay,
  validateDates,
} from "../public/js/flow/wizardState.js";
import { buildInfoCard } from "../public/js/render/callPanel.js";
import { buildRequestFields } from "../public/js/render/header.js";
import { createInitialState, runReducer, selectCalls } from "../public/js/state.js";
import type { RunState } from "../public/js/state.js";
import { ASK_ABOUT, buildDatesSentence, buildHotelSearch, buildRequestSentence } from "../public/js/stay.js";
import type { StayRequest } from "../public/js/stay.js";
import { RunRegistry } from "../src/api/registry";
import { createApp } from "../src/app";
import type { AgentEvent } from "../src/core/events";
import { startRecorder } from "../src/core/recorder";
import { PlacesDirectory } from "../src/places/placesDirectory";
import { SAMPLE_HOTELS, samplePlacesProvider } from "../src/places/samplePlaces";
import { elevenLabsClient } from "../src/providers/elevenLabs";
import type { FetchFunction } from "../src/providers/elevenLabs";
import { buildDynamicVariables, liveProvider } from "../src/providers/live";
import type { LiveLimits } from "../src/providers/live";
import { createQuoteExtractor } from "../src/providers/quoteExtractor";
import type { CallProvider } from "../src/providers/types";
import { parseStay, stayToJob, todayIso } from "../src/stay";

const TODAY = "2026-11-09";
const TEST_DIGITS = "4165550123";

function stay(overrides: Partial<StayRequest> = {}): StayRequest {
  return {
    area: "downtown Toronto",
    checkIn: "2026-11-20",
    checkOut: "2026-11-22",
    guests: 2,
    bed: "king",
    ...overrides,
  };
}

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
  const directory = mkdtempSync(join(tmpdir(), "quotedesk-stay-"));
  tempDirectories.push(directory);
  return directory;
}

describe("stay validation", () => {
  it("accepts a complete stay", () => {
    expect(parseStay(stay(), TODAY)).toMatchObject({ ok: true });
  });

  it("refuses check-out on or before check-in", () => {
    const sameDay = parseStay(stay({ checkOut: "2026-11-20" }), TODAY);

    expect(sameDay).toMatchObject({ ok: false });
    expect(JSON.stringify(sameDay)).toContain("must be after check-in");
    expect(parseStay(stay({ checkOut: "2026-11-19" }), TODAY)).toMatchObject({ ok: false });
  });

  it("refuses a check-in in the past, allowing a day for time zones", () => {
    expect(parseStay(stay({ checkIn: "2026-11-01", checkOut: "2026-11-03" }), TODAY)).toMatchObject({ ok: false });
    expect(parseStay(stay({ checkIn: "2026-11-08", checkOut: "2026-11-10" }), TODAY)).toMatchObject({ ok: true });
  });

  it("needs 1 to 8 guests and a known bed", () => {
    expect(parseStay(stay({ guests: 0 }), TODAY)).toMatchObject({ ok: false });
    expect(parseStay(stay({ guests: 9 }), TODAY)).toMatchObject({ ok: false });
    expect(parseStay({ ...stay(), bed: "queen" }, TODAY)).toMatchObject({ ok: false });
  });

  it("only takes area, dates, guests and bed", () => {
    expect(parseStay({ ...stay(), near: "Union Station" }, TODAY)).toMatchObject({ ok: false });
    expect(parseStay({ ...stay(), maxPerNight: 200 }, TODAY)).toMatchObject({ ok: false });
    expect(parseStay({ ...stay(), phone: "+15555550123" }, TODAY)).toMatchObject({ ok: false });
  });

  it("uses the server's own date by default", () => {
    expect(todayIso(new Date(2026, 10, 9))).toBe("2026-11-09");
  });
});

describe("what the agent says", () => {
  it("builds the request from guests and bed", () => {
    expect(buildRequestSentence(stay())).toBe("one room with a king bed for 2 guests");
    expect(buildRequestSentence(stay({ bed: "two-queens", guests: 4 }))).toBe("one room with two queen beds for 4 guests");
    expect(buildRequestSentence(stay({ bed: "any" }))).toBe("one room for 2 guests");
    expect(buildRequestSentence(stay({ guests: 1 }))).toBe("one room with a king bed for 1 guest");
  });

  it("says the dates the way a person would, with the nights", () => {
    expect(buildDatesSentence("2026-11-20", "2026-11-22")).toBe("November 20 to 22, 2 nights");
    expect(buildDatesSentence("2026-11-30", "2026-12-01")).toBe("November 30 to December 1, 1 night");
  });

  it("always asks the same three things and never gives a name", () => {
    const variables = buildDynamicVariables(stayToJob(stay({ bed: "any" })), "Unused Name", "live");

    expect(Object.keys(variables).sort()).toEqual(
      ["ask_about", "call_mode", "dates", "first_message_intro", "guest_name", "request"].sort(),
    );
    expect(variables).toMatchObject({
      request: "one room for 2 guests",
      dates: "November 20 to 22, 2 nights",
      ask_about: "free cancellation, whether breakfast is included, and whether there's a lower rate available",
      guest_name: "a guest",
    });
    expect(ASK_ABOUT).toBe(variables.ask_about);
  });

  it("searches the area for hotels", () => {
    expect(buildHotelSearch(" Toronto ")).toBe("hotels in Toronto");
  });
});

describe("hotel list", () => {
  it("never offers call centers and puts the best rated first", () => {
    const shown = listCallableHotels(SAMPLE_HOTELS);

    expect(shown.map((hotel) => hotel.name)).toEqual([
      "Yorkville House",
      "Distillery Lofts",
      "Maple Court Hotel",
      "Lakeview Suites",
      "Queens Quay Hotel",
      "King Street Inn",
    ]);
    expect(shown.some((hotel) => hotel.tollFree)).toBe(false);
    expect(SAMPLE_HOTELS.some((hotel) => hotel.tollFree)).toBe(true);
  });

  it("picks the top hotels in that order", () => {
    expect(pickTop(listCallableHotels(SAMPLE_HOTELS), 2)).toEqual(["sample-yorkville-house", "sample-distillery-lofts"]);
  });
});

describe("wizard state", () => {
  it("has three steps", () => {
    expect(STEPS.map((step) => step.question)).toEqual([
      "Where are you staying?",
      "When and who?",
      "Which hotels should we call?",
    ]);
  });

  it("is never written anywhere but memory", () => {
    const sources = [
      ...readdirSync("public/js/flow").map((name) => readFileSync(join("public/js/flow", name), "utf8")),
      readFileSync("public/js/stay.js", "utf8"),
    ];
    const banned = ["localStorage", "sessionStorage", "document.cookie", "pushState", "replaceState", "location.hash", "URLSearchParams"];

    for (const source of sources) {
      for (const word of banned) {
        expect(source).not.toContain(word);
      }
    }
  });

  it("only lets each step continue once it is valid", () => {
    const state = createWizardState();

    expect(isStepValid(state, 0, TODAY)).toBe(false);
    state.area = "downtown Toronto";
    expect(isStepValid(state, 0, TODAY)).toBe(true);

    expect(isStepValid(state, 1, TODAY)).toBe(false);
    state.checkIn = "2026-11-20";
    state.checkOut = "2026-11-19";
    expect(validateDates(state.checkIn, state.checkOut, TODAY)).toBe("Check-out has to be after check-in.");
    state.checkOut = "2026-11-22";
    expect(isStepValid(state, 1, TODAY)).toBe(false);
    state.bed = "king";
    expect(isStepValid(state, 1, TODAY)).toBe(true);
    state.guests = 9;
    expect(isStepValid(state, 1, TODAY)).toBe(false);
    state.guests = 3;

    expect(isStepValid(state, 2, TODAY)).toBe(false);
    state.picked = ["sample-maple-court"];
    expect(isStepValid(state, 2, TODAY)).toBe(true);
  });

  it("turns the answers into the stay the server expects, and summarizes completed steps", () => {
    const state = createWizardState();
    state.area = " downtown Toronto ";
    state.checkIn = "2026-11-20";
    state.checkOut = "2026-11-22";
    state.guests = 3;
    state.bed = "two-queens";
    state.reached = 2;

    expect(buildStayPayload(state)).toEqual(stay({ guests: 3, bed: "two-queens" }));
    expect(summarizeStay(state)).toEqual([
      { label: "Where", value: "downtown Toronto" },
      { label: "When", value: "Nov 20 to 22 · 2 nights" },
      { label: "Who", value: "3 guests · 2 queens" },
    ]);
  });

  it("confirms the dates, guests and bed, and what the agent asks about, with no name", () => {
    expect(describeAgentAsks(stay())).toEqual([
      { label: "Dates", value: "November 20 to 22, 2 nights" },
      { label: "Guests and bed", value: "2 guests · 1 king" },
      { label: "Asks about", value: "cancellation, breakfast and lower rates" },
    ]);
  });

  it("builds the fixed sample stay two weeks out for test calls", () => {
    expect(buildSampleStay(TODAY)).toEqual({
      area: "downtown Toronto",
      checkIn: "2026-11-23",
      checkOut: "2026-11-25",
      guests: 2,
      bed: "king",
    });
  });
});

type FakeLine = {
  provider: CallProvider;
  outbound: Record<string, unknown>[];
};

// Records what each outbound call asked ElevenLabs to say.
function fakeLine(runsDirectory: string): FakeLine {
  const outbound: Record<string, unknown>[] = [];

  async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = String(input);

    if (url.endsWith("/twilio/outbound-call")) {
      if (init !== undefined) {
        outbound.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      }

      return Response.json({ success: true, message: "ok", conversation_id: "conv-1", callSid: "CA1" });
    }

    if (url.endsWith("/audio")) {
      return new Response(new Uint8Array([1, 2, 3]));
    }

    return Response.json({ status: "done", transcript: [{ role: "user", message: "It's 400.", time_in_call_secs: 1 }] });
  }

  const provider = liveProvider({
    client: elevenLabsClient({ apiKey: "k", agentId: "a", phoneNumberId: "p", fetch: fakeFetch as FetchFunction }),
    extractQuote: createQuoteExtractor(async () => JSON.stringify({ quote: { total: 400 }, notes: [] })),
    guestName: "Server Default Name",
    allowedNumbers: [],
    maxCalls: 6,
    callTimeoutMs: 10_000,
    runsDirectory,
    pollMs: 5,
    spacingMs: 0,
  });

  return { provider, outbound };
}

const limits: LiveLimits = { allowedNumbers: [], maxCalls: 6, callTimeoutMs: 10_000, selfTest: true, guestName: "Server Default Name" };

function buildApp() {
  const runsDirectory = createTempDirectory();
  const registry = new RunRegistry();
  const line = fakeLine(runsDirectory);
  stoppers.push(registry.start());
  stoppers.push(startRecorder(runsDirectory));

  const app = createApp({
    jobsDirectory: "data/jobs",
    runsDirectory,
    publicDirectory: "public",
    runOptions: { maxParallelCalls: 3, decisionWindowMs: 2_000, runTimeoutMs: 5_000, settleGraceMs: 10, priceFlagPct: 10 },
    maxTurns: 14,
    createProvider: () => line.provider,
    registry,
    liveLimits: limits,
    placesDirectory: new PlacesDirectory(samplePlacesProvider()),
  });

  return { app, registry, outbound: line.outbound };
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

function runEvents(registry: RunRegistry, runId: string): AgentEvent[] {
  const events = registry.getEvents(runId);

  if (events === undefined) {
    throw new Error("No events for this run.");
  }

  return events;
}

// The server checks dates against its own clock, so the test stay is always in the future.
function futureStay(overrides: Partial<StayRequest> = {}): StayRequest {
  return { ...buildSampleStay(todayIso()), ...overrides };
}

describe("a run from the wizard", () => {
  it("calls the picked sample hotels with the stay's sentences and no name", async () => {
    const { app, registry, outbound } = buildApp();
    const wizardStay = futureStay({ guests: 3, bed: "two-queens" });
    await request(app).post("/api/places/search").send({ query: buildHotelSearch(wizardStay.area) });

    const started = await request(app)
      .post("/api/runs")
      .send({ provider: "live", stay: wizardStay, placeIds: ["sample-maple-court", "sample-king-street-inn"] });
    expect(started.status).toBe(201);
    await waitForSummary(app, started.body.runId);

    const runStarted = runEvents(registry, started.body.runId).find((event) => event.type === "run_started");
    const variables = outbound.map(
      (body) => (body.conversation_initiation_client_data as { dynamic_variables: Record<string, string> }).dynamic_variables,
    );

    expect(runStarted).toMatchObject({ businesses: [{ name: "Maple Court Hotel" }, { name: "King Street Inn" }] });
    expect(JSON.stringify(runStarted)).not.toContain("Server Default Name");
    expect(variables).toHaveLength(2);
    expect(variables[0]).toMatchObject({
      request: "one room with two queen beds for 3 guests",
      ask_about: ASK_ABOUT,
      guest_name: "a guest",
      call_mode: "live",
    });
  });

  it("refuses a stay that is incomplete, mixed with a job, or not live", async () => {
    const { app } = buildApp();

    const noHotels = await request(app).post("/api/runs").send({ provider: "live", stay: futureStay() });
    const both = await request(app)
      .post("/api/runs")
      .send({ provider: "live", jobId: "toronto-weekend", stay: futureStay(), placeIds: ["x"] });
    const demo = await request(app).post("/api/runs").send({ provider: "fake", stay: futureStay(), placeIds: ["x"] });
    const broken = await request(app)
      .post("/api/runs")
      .send({ provider: "live", stay: { ...futureStay(), guests: 0 }, placeIds: ["x"] });

    expect(noHotels.body.error).toContain("Pick at least one hotel");
    expect(both.body.error).toContain("not both");
    expect(demo.body.error).toContain("only works for live calls");
    expect(broken.status).toBe(400);
    expect(broken.body.error).toContain("guests");
  });

  it("runs the home page's test call with the sample stay and only ever shows the masked number", async () => {
    const { app, registry, outbound } = buildApp();

    const started = await request(app)
      .post("/api/runs")
      .send({ provider: "live", stay: futureStay(), testNumber: "416 555 0123" });
    expect(started.status).toBe(201);
    await waitForSummary(app, started.body.runId);

    const events = runEvents(registry, started.body.runId);
    let state: RunState = createInitialState();

    for (const event of events) {
      state = runReducer(state, event);
    }

    const call = selectCalls(state)[0];

    if (call === undefined) {
      throw new Error("Expected one call.");
    }

    expect(call).toMatchObject({ name: "Test call", maskedPhone: "+1 ••• ••• ••23", listing: null });
    expect(buildInfoCard(call)).toBeNull();
    expect(JSON.stringify(events)).not.toContain(TEST_DIGITS);
    expect(outbound[0]).toMatchObject({ conversation_initiation_client_data: { dynamic_variables: { call_mode: "test" } } });
  });
});

describe("dashboard header for a wizard run", () => {
  it("shows the stay summary and counts hotels, not a job title", () => {
    const fields = buildRequestFields(stayToJob(stay()), "Hotel rooms", 3, null);

    expect(fields.map((field) => [field.label, field.value])).toEqual([
      ["Area", "downtown Toronto"],
      ["Dates", "Nov 20 to 22 · 2 nights"],
      ["Guests", "2 guests · 1 king"],
      ["Calling", "3 hotels"],
    ]);
  });
});
