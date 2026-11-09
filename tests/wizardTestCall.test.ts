import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { buildSampleStay } from "../public/js/flow/wizardState.js";
import { buildBriefRows } from "../public/js/render/callPanel.js";
import type { View } from "../public/js/render/view.js";
import { createInitialState, runReducer, selectCalls } from "../public/js/state.js";
import type { RunState } from "../public/js/state.js";
import type { StayRequest } from "../public/js/stay.js";
import { RunRegistry } from "../src/api/registry";
import { SelfTestLimiter } from "../src/api/selfTest";
import { createApp } from "../src/app";
import type { AgentEvent } from "../src/core/events";
import { getRunLogPath, startRecorder } from "../src/core/recorder";
import { PlacesDirectory } from "../src/places/placesDirectory";
import { samplePlacesProvider } from "../src/places/samplePlaces";
import { elevenLabsClient } from "../src/providers/elevenLabs";
import type { FetchFunction } from "../src/providers/elevenLabs";
import { FIRST_MESSAGE_INTROS, liveProvider } from "../src/providers/live";
import type { LiveLimits } from "../src/providers/live";
import { createQuoteExtractor } from "../src/providers/quoteExtractor";
import type { CallProvider } from "../src/providers/types";
import { todayIso } from "../src/stay";

// Only numbers reserved for fiction (555-0100 to 555-0199) appear in tests.
const TEST_NUMBER = "+14165550123";
const TEST_DIGITS = "4165550123";
const MASKED = "+1 ••• ••• ••23";

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
  const directory = mkdtempSync(join(tmpdir(), "quotedesk-wizard-test-"));
  tempDirectories.push(directory);
  return directory;
}

type Outbound = { to: string; variables: Record<string, string> };

// Records who each outbound call rang and what the agent was told.
function fakeLine(runsDirectory: string, outbound: Outbound[]): CallProvider {
  async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = String(input);

    if (url.endsWith("/twilio/outbound-call") && init !== undefined) {
      const body = JSON.parse(String(init.body)) as {
        to_number: string;
        conversation_initiation_client_data: { dynamic_variables: Record<string, string> };
      };
      outbound.push({ to: body.to_number, variables: body.conversation_initiation_client_data.dynamic_variables });
      return Response.json({ success: true, message: "ok", conversation_id: "conv-1", callSid: "CA1" });
    }

    if (url.endsWith("/audio")) {
      return new Response(new Uint8Array([1, 2, 3]));
    }

    return Response.json({ status: "done", transcript: [{ role: "user", message: "It's 400 for the two nights.", time_in_call_secs: 1 }] });
  }

  return liveProvider({
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
}

type AppSettings = {
  selfTest?: boolean;
  selfTestLimiter?: SelfTestLimiter;
};

function buildApp(settings: AppSettings = {}) {
  const runsDirectory = createTempDirectory();
  const registry = new RunRegistry();
  const outbound: Outbound[] = [];
  let selfTest = true;

  if (settings.selfTest !== undefined) {
    selfTest = settings.selfTest;
  }

  const limits: LiveLimits = { allowedNumbers: [], maxCalls: 6, callTimeoutMs: 10_000, selfTest };
  stoppers.push(registry.start());
  stoppers.push(startRecorder(runsDirectory));

  const app = createApp({
    jobsDirectory: "data/jobs",
    runsDirectory,
    publicDirectory: "public",
    runOptions: { maxParallelCalls: 3, decisionWindowMs: 2_000, runTimeoutMs: 5_000, settleGraceMs: 10, priceFlagPct: 10 },
    maxTurns: 14,
    createProvider: () => fakeLine(runsDirectory, outbound),
    registry,
    liveLimits: limits,
    placesDirectory: new PlacesDirectory(samplePlacesProvider()),
    selfTestLimiter: settings.selfTestLimiter,
  });

  return { app, registry, runsDirectory, outbound };
}

// A wizard stay that differs from the sample, always in the future for the server.
function wizardStay(): StayRequest {
  return { ...buildSampleStay(todayIso()), guests: 3, bed: "two-queens" };
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

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) {
    throw new Error("Expected a value.");
  }

  return value;
}

function eventsOf(registry: RunRegistry, runId: string): AgentEvent[] {
  const events = registry.getEvents(runId);

  if (events === undefined) {
    throw new Error("No events for this run.");
  }

  return events;
}

function reduce(events: AgentEvent[]): RunState {
  let state = createInitialState();

  for (const event of events) {
    state = runReducer(state, event);
  }

  return state;
}

function viewOf(state: RunState): View {
  return { state, now: 0, listing: null, selectedCallId: null, filter: "all", search: "", sort: "price", ended: true } as View;
}

function onlyBriefs(events: AgentEvent[]): Record<string, string>[] {
  const briefs: Record<string, string>[] = [];

  for (const event of events) {
    if (event.type === "call_brief") {
      briefs.push(event.variables);
    }
  }

  return briefs;
}

describe("Call me instead from the wizard", () => {
  it("sends the same variables a hotel call would get, with the real call script", async () => {
    const { app, outbound } = buildApp();
    await request(app).post("/api/places/search").send({ query: "hotels in downtown Toronto" });

    const hotelRun = await request(app)
      .post("/api/runs")
      .send({ provider: "live", stay: wizardStay(), placeIds: ["sample-maple-court"] });
    await waitForSummary(app, hotelRun.body.runId);

    const testRun = await request(app)
      .post("/api/runs")
      .send({ provider: "live", stay: wizardStay(), testNumber: "416 555 0123", testCallMode: "live" });
    expect(testRun.status).toBe(201);
    await waitForSummary(app, testRun.body.runId);

    const hotelCall = required(outbound[0]);
    const testCall = required(outbound[1]);
    expect(testCall.variables).toEqual(hotelCall.variables);
    expect(testCall.variables).toMatchObject({
      request: "one room with two queen beds for 3 guests",
      ask_about: "free cancellation, whether breakfast is included, and whether there's a lower rate available",
      guest_name: "a guest",
      call_mode: "live",
      first_message_intro: FIRST_MESSAGE_INTROS.live,
    });
  });

  it("uses the tutorial when asked, and by default", async () => {
    const { app, outbound } = buildApp();

    const tutorial = await request(app)
      .post("/api/runs")
      .send({ provider: "live", stay: wizardStay(), testNumber: TEST_NUMBER, testCallMode: "test" });
    await waitForSummary(app, tutorial.body.runId);
    const unspecified = await request(app).post("/api/runs").send({ provider: "live", stay: wizardStay(), testNumber: TEST_NUMBER });
    await waitForSummary(app, unspecified.body.runId);

    expect(outbound.map((call) => call.variables.call_mode)).toEqual(["test", "test"]);
    const tutorialCall = required(outbound[0]);
    expect(tutorialCall.variables.first_message_intro).toBe(FIRST_MESSAGE_INTROS.test);
    expect(tutorialCall.variables.request).toBe("one room with two queen beds for 3 guests");
  });

  it("rings only the test number, never the picked hotels", async () => {
    const { app, registry, outbound } = buildApp();
    await request(app).post("/api/places/search").send({ query: "hotels in downtown Toronto" });

    const started = await request(app)
      .post("/api/runs")
      .send({ provider: "live", stay: wizardStay(), testNumber: TEST_NUMBER, testCallMode: "live" });
    await waitForSummary(app, started.body.runId);

    const runStarted = eventsOf(registry, started.body.runId).find((event) => event.type === "run_started");
    expect(outbound.map((call) => call.to)).toEqual([TEST_NUMBER]);
    expect(runStarted).toMatchObject({ businesses: [{ name: "Test call", maskedPhone: MASKED }] });
    expect(JSON.stringify(runStarted)).not.toContain("publicListing");
  });

  it("masks the test number in events, the run log and the summary", async () => {
    const { app, registry, runsDirectory } = buildApp();

    const started = await request(app)
      .post("/api/runs")
      .send({ provider: "live", stay: wizardStay(), testNumber: "(416) 555-0123", testCallMode: "live" });
    const summary = await waitForSummary(app, started.body.runId);
    const events = eventsOf(registry, started.body.runId);
    const logText = readFileSync(getRunLogPath(runsDirectory, started.body.runId), "utf8");

    for (const text of [JSON.stringify(events), logText, summary.text, started.text]) {
      expect(text).not.toContain(TEST_DIGITS);
      expect(text).not.toContain("555-0123");
    }

    expect(JSON.stringify(events)).toContain(MASKED);
  });

  it("follows the same LIVE_SELF_TEST switch and hourly limit as Call me to test", async () => {
    const off = buildApp({ selfTest: false });
    const limiter = new SelfTestLimiter();
    limiter.take();
    limiter.take();
    limiter.take();
    const full = buildApp({ selfTestLimiter: limiter });

    const refused = await request(off.app)
      .post("/api/runs")
      .send({ provider: "live", stay: wizardStay(), testNumber: TEST_NUMBER, testCallMode: "live" });
    const limited = await request(full.app)
      .post("/api/runs")
      .send({ provider: "live", stay: wizardStay(), testNumber: TEST_NUMBER, testCallMode: "live" });
    const modeWithoutNumber = await request(full.app)
      .post("/api/runs")
      .send({ provider: "live", stay: wizardStay(), placeIds: ["x"], testCallMode: "live" });

    expect(refused.body.error).toContain("LIVE_SELF_TEST=false");
    expect(limited.status).toBe(429);
    expect(modeWithoutNumber.body.error).toContain("only applies to a test call");
  });
});

describe("Sent to the agent", () => {
  it("records the five variables for each call, never the number", async () => {
    const { app, registry } = buildApp();

    const started = await request(app)
      .post("/api/runs")
      .send({ provider: "live", stay: wizardStay(), testNumber: TEST_NUMBER, testCallMode: "live" });
    await waitForSummary(app, started.body.runId);

    const events = eventsOf(registry, started.body.runId);
    const briefs = onlyBriefs(events);

    expect(briefs).toHaveLength(1);
    expect(Object.keys(briefs[0] as Record<string, string>)).toEqual(["request", "dates", "ask_about", "guest_name", "call_mode"]);
    expect(JSON.stringify(briefs)).not.toContain(TEST_DIGITS);

    const state = reduce(events);
    const call = selectCalls(state)[0];

    if (call === undefined) {
      throw new Error("Expected one call.");
    }

    const rows = buildBriefRows(viewOf(state), call);
    expect(rows).toEqual([
      { label: "Request", value: "one room with two queen beds for 3 guests" },
      { label: "Dates", value: (briefs[0] as Record<string, string>).dates },
      { label: "Asks about", value: "free cancellation, whether breakfast is included, and whether there's a lower rate available" },
      { label: "Guest name", value: "a guest" },
      { label: "Call mode", value: "Real call script (live)" },
    ]);
    expect(JSON.stringify(rows)).not.toContain(TEST_DIGITS);
  });

  it("is only shown on live runs", () => {
    const demo = reduce([
      {
        type: "run_started",
        runId: "run-demo",
        at: 0,
        job: { id: "toronto-weekend", industryId: "hotels", title: "Demo", request: "a room" },
        industryLabel: "Hotel rooms",
        provider: "fake",
        businesses: [{ id: "harbour-inn", name: "Harbour Inn" }],
      },
      {
        type: "call_brief",
        runId: "run-demo",
        at: 1,
        callId: "call-harbour-inn",
        businessId: "harbour-inn",
        variables: { request: "a room" },
      },
    ]);
    const call = selectCalls(demo)[0];

    if (call === undefined) {
      throw new Error("Expected one call.");
    }

    expect(buildBriefRows(viewOf(demo), call)).toBeNull();
  });
});
