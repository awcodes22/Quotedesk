import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROVIDER_OPTIONS } from "../public/js/render/header.js";
import { RunRegistry } from "../src/api/registry";
import { summarizeRun } from "../src/api/summary";
import { createApp } from "../src/app";
import { onEvent } from "../src/core/events";
import type { AgentEvent } from "../src/core/events";
import { runJob } from "../src/core/run";
import type { CallOutcome, CallStatus, Job, SimBusiness } from "../src/core/types";
import { hotels } from "../src/industries/hotels";
import { listJobs, loadJob } from "../src/jobs";
import { elevenLabsClient } from "../src/providers/elevenLabs";
import type { ConversationStatus, ConversationTurn, FetchFunction } from "../src/providers/elevenLabs";
import { createProvider, findMissingLiveSettings } from "../src/providers/index";
import type { ProviderConfig } from "../src/providers/index";
import {
  audioPath,
  buildDynamicVariables,
  checkLiveBusinesses,
  cleanSpokenText,
  formatStayDates,
  liveProvider,
  toSimBusinesses,
  toTranscriptLines,
} from "../src/providers/live";
import type { LiveProviderOptions } from "../src/providers/live";
import { createQuoteExtractor } from "../src/providers/quoteExtractor";
import type { JsonCompletion } from "../src/providers/quoteExtractor";
import type { CallContext, SpokenLine } from "../src/providers/types";

const EXAMPLE_JOB_PATH = "data/jobs/examples/hotels-live.example.json";
const ALLOWED = "+15555550101";
const OTHER_ALLOWED = "+15555550102";
const NOT_ALLOWED = "+15555550199";

type RecordedRequest = {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
  at: number;
};

type FakeElevenLabs = {
  fetch: FetchFunction;
  requests: RecordedRequest[];
};

type FakeElevenLabsOptions = {
  statuses: ConversationStatus[];
  transcript: ConversationTurn[];
  outboundReply?: Record<string, unknown>;
};

type CallLog = {
  statuses: CallStatus[];
  lines: SpokenLine[];
  notes: string[];
  quotes: unknown[];
};

const tempDirectories: string[] = [];

const sampleTranscript: ConversationTurn[] = [
  { role: "user", message: "[cheerful] Harbour Inn, how can I help?", time_in_call_secs: 1 },
  { role: "agent", message: "Hi, what's the total for November 20 to 22?", time_in_call_secs: 4 },
  { role: "user", message: "...", time_in_call_secs: 8 },
  { role: "user", message: "It's 412 with taxes. Breakfast is included.", time_in_call_secs: 12 },
  { role: "agent", message: null, time_in_call_secs: 15 },
];

const quoteReply = JSON.stringify({
  quote: { total: 412, includesTaxes: true },
  notes: ["Breakfast is included."],
});

function createTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "quotedesk-live-"));
  tempDirectories.push(directory);
  return directory;
}

function readBody(init: RequestInit | undefined): Record<string, unknown> | undefined {
  if (init === undefined || typeof init.body !== "string") {
    return undefined;
  }

  return JSON.parse(init.body) as Record<string, unknown>;
}

function nextStatus(statuses: ConversationStatus[], lookups: number): ConversationStatus {
  const index = Math.min(lookups, statuses.length - 1);
  const status = statuses[index];

  if (status === undefined) {
    throw new Error("The fake needs at least one status.");
  }

  return status;
}

// Answers the three ElevenLabs endpoints the way the docs describe them.
function createFakeElevenLabs(options: FakeElevenLabsOptions): FakeElevenLabs {
  const requests: RecordedRequest[] = [];
  const lookups = new Map<string, number>();
  let outboundCount = 0;

  async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = String(input);
    let method = "GET";

    if (init !== undefined && init.method !== undefined) {
      method = init.method;
    }

    requests.push({ method, url, body: readBody(init), at: Date.now() });

    if (url.endsWith("/twilio/outbound-call")) {
      outboundCount += 1;
      let reply: Record<string, unknown> = {
        success: true,
        message: "Call started",
        conversation_id: `conv-${outboundCount}`,
        callSid: `CA${outboundCount}`,
      };

      if (options.outboundReply !== undefined) {
        reply = options.outboundReply;
      }

      return Response.json(reply);
    }

    if (url.endsWith("/audio")) {
      return new Response(new Uint8Array([73, 68, 51]), { headers: { "Content-Type": "audio/mpeg" } });
    }

    const conversationId = url.split("/").pop();
    let seen = 0;
    const previous = lookups.get(String(conversationId));

    if (previous !== undefined) {
      seen = previous;
    }

    lookups.set(String(conversationId), seen + 1);
    const status = nextStatus(options.statuses, seen);
    return Response.json({ status, transcript: options.transcript, has_audio: true });
  }

  return { fetch: fakeFetch as FetchFunction, requests };
}

function required<Value>(value: Value | undefined | null): Value {
  if (value === undefined || value === null) {
    throw new Error("Expected a value.");
  }

  return value;
}

function countRequests(fake: FakeElevenLabs, ending: string): number {
  return fake.requests.filter((recorded) => recorded.url.endsWith(ending)).length;
}

function countLookups(fake: FakeElevenLabs): number {
  return fake.requests.filter((recorded) => /\/conversations\/conv-[0-9]+$/.test(recorded.url)).length;
}

function liveJob(): Job {
  const job = loadJob(EXAMPLE_JOB_PATH);
  return { ...job, liveBusinesses: undefined };
}

function buildOptions(
  fake: FakeElevenLabs,
  overrides: Partial<LiveProviderOptions> = {},
): LiveProviderOptions {
  return {
    client: elevenLabsClient({ apiKey: "test-key", agentId: "agent-1", phoneNumberId: "phone-1", fetch: fake.fetch }),
    extractQuote: createQuoteExtractor(async () => quoteReply),
    guestName: "Jane Doe",
    allowedNumbers: [ALLOWED, OTHER_ALLOWED],
    maxCalls: 6,
    callTimeoutMs: 60_000,
    runsDirectory: createTempDirectory(),
    pollMs: 3_000,
    spacingMs: 1_200,
    ...overrides,
  };
}

function buildBusiness(id: string, phone: string): SimBusiness {
  return { id, name: `Hotel ${id}`, instructions: "", fakeQuotes: [], phone };
}

function buildContext(business: SimBusiness, log: CallLog): CallContext {
  return {
    runId: "run-test",
    callId: `call-${business.id}`,
    job: liveJob(),
    industry: hotels,
    business,
    reportQuote: (raw) => {
      log.quotes.push(raw);
      return { ok: true, quote: { callId: "", businessId: "", total: 0, fields: { total: 0 }, receivedAt: 0 } };
    },
    reportNote: (text) => log.notes.push(text),
    onStatus: (status) => log.statuses.push(status),
    onTranscript: (line) => log.lines.push(line),
  };
}

function createLog(): CallLog {
  return { statuses: [], lines: [], notes: [], quotes: [] };
}

// Moves fake time forward until the promise settles, so polling and spacing run instantly.
async function settle<Value>(promise: Promise<Value>, stepMs: number = 500): Promise<Value> {
  let finished = false;

  promise.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );

  for (let step = 0; step < 2_000 && finished === false; step += 1) {
    await vi.advanceTimersByTimeAsync(stepMs);
  }

  return promise;
}

afterEach(() => {
  vi.useRealTimers();

  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("formatStayDates", () => {
  it("says dates in one month the way a person would", () => {
    expect(formatStayDates("2026-11-20", "2026-11-22")).toBe("November 20 to 22");
  });

  it("names both months when the stay crosses one", () => {
    expect(formatStayDates("2026-11-30", "2026-12-02")).toBe("November 30 to December 2");
  });

  it("refuses a date it can't read", () => {
    expect(() => formatStayDates("20/11/2026", "2026-11-22")).toThrow("not a date");
  });
});

describe("buildDynamicVariables", () => {
  it("fills every variable the agent prompt uses, with no ISO dates", () => {
    const variables = buildDynamicVariables(liveJob(), "Jane Doe");

    expect(variables).toEqual({
      request: "a room for 2 guests for 2 nights",
      dates: "November 20 to 22",
      beds: "one king bed",
      guest_name: "Jane Doe",
    });
    expect(JSON.stringify(variables)).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe("cleanSpokenText", () => {
  it("strips voice tags in square brackets", () => {
    expect(cleanSpokenText("[happy] Hello there [laughs] friend")).toBe("Hello there friend");
  });

  it("drops turns that are empty, only dots or only tags", () => {
    expect(cleanSpokenText("...")).toBeUndefined();
    expect(cleanSpokenText("…")).toBeUndefined();
    expect(cleanSpokenText("   ")).toBeUndefined();
    expect(cleanSpokenText("[pause]")).toBeUndefined();
    expect(cleanSpokenText(null)).toBeUndefined();
  });
});

describe("toTranscriptLines", () => {
  it("maps the person who answered to the business and times each turn from the answer", () => {
    const lines = toTranscriptLines(sampleTranscript, 10_000);

    expect(lines).toEqual([
      { speaker: "business", text: "Harbour Inn, how can I help?", at: 11_000 },
      { speaker: "agent", text: "Hi, what's the total for November 20 to 22?", at: 14_000 },
      { speaker: "business", text: "It's 412 with taxes. Breakfast is included.", at: 22_000 },
    ]);
  });
});

describe("checkLiveBusinesses", () => {
  const limits = { allowedNumbers: [ALLOWED, OTHER_ALLOWED], maxCalls: 1, callTimeoutMs: 60_000 };

  it("accepts a list inside the allowlist and the cap", () => {
    expect(checkLiveBusinesses([{ name: "First", phone: ALLOWED }], limits)).toBeUndefined();
  });

  it("refuses a number that isn't on the allowlist, without repeating it", () => {
    const problem = checkLiveBusinesses([{ name: "Stranger Hotel", phone: NOT_ALLOWED }], limits);

    expect(problem).toContain("Stranger Hotel is not on LIVE_ALLOWED_NUMBERS");
    expect(problem).not.toContain(NOT_ALLOWED);
  });

  it("refuses more businesses than LIVE_MAX_CALLS", () => {
    const businesses = [
      { name: "First", phone: ALLOWED },
      { name: "Second", phone: OTHER_ALLOWED },
    ];

    expect(checkLiveBusinesses(businesses, limits)).toContain("LIVE_MAX_CALLS allows 1");
  });

  it("refuses an empty list", () => {
    expect(checkLiveBusinesses([], limits)).toContain("no live businesses");
  });
});

describe("live provider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("never dials a number that isn't on the allowlist", async () => {
    const fake = createFakeElevenLabs({ statuses: ["done"], transcript: [] });
    const provider = liveProvider(buildOptions(fake));
    const log = createLog();

    const outcome = await settle(provider.startCall(buildContext(buildBusiness("a", NOT_ALLOWED), log)).done);

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("not on LIVE_ALLOWED_NUMBERS");
    expect(fake.requests).toHaveLength(0);
    expect(log.statuses).toEqual(["failed"]);
  });

  it("refuses calls past LIVE_MAX_CALLS in one run", async () => {
    const fake = createFakeElevenLabs({ statuses: ["done"], transcript: [] });
    const provider = liveProvider(buildOptions(fake, { maxCalls: 1 }));

    const first = provider.startCall(buildContext(buildBusiness("a", ALLOWED), createLog()));
    const second = provider.startCall(buildContext(buildBusiness("b", OTHER_ALLOWED), createLog()));
    const outcomes = await settle(Promise.all([first.done, second.done]));

    expect(outcomes[0]).toMatchObject({ status: "completed" });
    expect(outcomes[1]).toMatchObject({ status: "failed" });
    expect(required(outcomes[1]).error).toContain("LIVE_MAX_CALLS allows 1");
    expect(countRequests(fake, "/twilio/outbound-call")).toBe(1);
  });

  it("starts parallel calls 1.2 seconds apart", async () => {
    const fake = createFakeElevenLabs({ statuses: ["done"], transcript: [] });
    const provider = liveProvider(buildOptions(fake, { allowedNumbers: [ALLOWED] }));
    const startedAt = Date.now();

    const handles = ["a", "b", "c"].map((id) => {
      return provider.startCall(buildContext(buildBusiness(id, ALLOWED), createLog()));
    });
    await settle(Promise.all(handles.map((handle) => handle.done)), 100);

    const outbound = fake.requests.filter((recorded) => recorded.url.endsWith("/twilio/outbound-call"));
    const offsets = outbound.map((recorded) => recorded.at - startedAt);
    expect(offsets).toEqual([0, 1_200, 2_400]);
  });

  it("sends the agent, the phone number and the dynamic variables", async () => {
    const fake = createFakeElevenLabs({ statuses: ["done"], transcript: [] });
    const provider = liveProvider(buildOptions(fake));

    await settle(provider.startCall(buildContext(buildBusiness("a", ALLOWED), createLog())).done);

    const outbound = required(fake.requests[0]);
    expect(outbound.method).toBe("POST");
    expect(outbound.url).toBe("https://api.elevenlabs.io/v1/convai/twilio/outbound-call");
    expect(outbound.body).toEqual({
      agent_id: "agent-1",
      agent_phone_number_id: "phone-1",
      to_number: ALLOWED,
      conversation_initiation_client_data: {
        dynamic_variables: {
          request: "a room for 2 guests for 2 nights",
          dates: "November 20 to 22",
          beds: "one king bed",
          guest_name: "Jane Doe",
        },
      },
    });
  });

  it("polls every 3 seconds until done, then reports the transcript, quote and notes", async () => {
    const fake = createFakeElevenLabs({
      statuses: ["initiated", "in-progress", "in-progress", "processing", "done"],
      transcript: sampleTranscript,
    });
    const options = buildOptions(fake);
    const provider = liveProvider(options);
    const log = createLog();
    const context = buildContext(buildBusiness("a", ALLOWED), log);

    const outcome = await settle(provider.startCall(context).done);

    expect(outcome.status).toBe("completed");
    expect(countLookups(fake)).toBe(5);
    expect(log.statuses).toEqual(["connecting", "talking", "quoted", "ended"]);
    expect(log.lines.map((line) => line.speaker)).toEqual(["business", "agent", "business"]);
    expect(log.quotes).toEqual([{ total: 412, includesTaxes: true }]);
    expect(log.notes).toEqual(["Breakfast is included."]);
    expect(existsSync(audioPath(options.runsDirectory, "run-test", "call-a"))).toBe(true);
  });

  it("gives up on a call that runs past LIVE_CALL_TIMEOUT_MS", async () => {
    const fake = createFakeElevenLabs({ statuses: ["in-progress"], transcript: [] });
    const provider = liveProvider(buildOptions(fake, { callTimeoutMs: 10_000 }));
    const log = createLog();

    const outcome = await settle(provider.startCall(buildContext(buildBusiness("a", ALLOWED), log)).done);

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("no result");
    expect(countLookups(fake)).toBe(4);
    expect(countRequests(fake, "/audio")).toBe(0);
    expect(log.statuses).toEqual(["connecting", "talking", "failed"]);
  });

  it("fails the call with the reason when ElevenLabs won't start it, hiding the number", async () => {
    const fake = createFakeElevenLabs({
      statuses: ["done"],
      transcript: [],
      outboundReply: { success: false, message: `Could not call ${ALLOWED}`, conversation_id: null, callSid: null },
    });
    const provider = liveProvider(buildOptions(fake));
    const log = createLog();

    const outcome = await settle(provider.startCall(buildContext(buildBusiness("a", ALLOWED), log)).done);

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("did not start the call");
    expect(outcome.error).not.toContain(ALLOWED);
    expect(log.notes[0]).toContain("Call failed");
  });

  it("ends without a quote when the call never got to a price", async () => {
    const fake = createFakeElevenLabs({ statuses: ["done"], transcript: sampleTranscript });
    const noPrice = createQuoteExtractor(async () => JSON.stringify({ quote: null, notes: [] }));
    const provider = liveProvider(buildOptions(fake, { extractQuote: noPrice }));
    const log = createLog();

    const outcome = await settle(provider.startCall(buildContext(buildBusiness("a", ALLOWED), log)).done);

    expect(outcome.status).toBe("completed");
    expect(log.quotes).toEqual([]);
    expect(log.statuses).toEqual(["connecting", "ended"]);
  });

  it("keeps the call when the price can't be read, and says why", async () => {
    const fake = createFakeElevenLabs({ statuses: ["done"], transcript: sampleTranscript });
    const broken = createQuoteExtractor(async () => "not json");
    const provider = liveProvider(buildOptions(fake, { extractQuote: broken }));
    const log = createLog();

    const outcome = await settle(provider.startCall(buildContext(buildBusiness("a", ALLOWED), log)).done);

    expect(outcome.status).toBe("completed");
    expect(log.lines).toHaveLength(3);
    expect(log.notes[0]).toContain("could not be read");
    expect(countRequests(fake, "/audio")).toBe(1);
  });

  it("never accepts a booking command", () => {
    const fake = createFakeElevenLabs({ statuses: ["done"], transcript: [] });
    const provider = liveProvider(buildOptions(fake));
    const handle = provider.startCall(buildContext(buildBusiness("a", ALLOWED), createLog()));

    expect(provider.recommendsOnly).toBe(true);
    expect(handle.send({ command: "close" })).toBe(false);
  });
});

describe("quote extraction", () => {
  it("validates the reply and keeps up to six trimmed notes", async () => {
    const reply = JSON.stringify({
      quote: { total: 398, freeCancellation: false },
      notes: [" Non-refundable rate. ", "", "Parking is $30 a night.", "a", "b", "c", "d", "e"],
    });
    const extract = createQuoteExtractor(async () => reply);

    const extraction = await extract([{ speaker: "business", text: "398, non-refundable." }], hotels);

    expect(extraction.fields).toEqual({ total: 398, freeCancellation: false });
    expect(extraction.notes).toEqual(["Non-refundable rate.", "Parking is $30 a night.", "a", "b", "c", "d"]);
  });

  it("refuses a quote that breaks the industry's schema", async () => {
    const extract = createQuoteExtractor(async () => JSON.stringify({ quote: { total: -5 }, notes: [] }));

    await expect(extract([{ speaker: "business", text: "Free!" }], hotels)).rejects.toThrow("quote schema");
  });

  it("asks the model with the hotel quote schema, and skips it for an empty call", async () => {
    const complete = vi.fn<JsonCompletion>(async () => quoteReply);
    const extract = createQuoteExtractor(complete);

    await extract([], hotels);
    expect(complete).not.toHaveBeenCalled();

    await extract([{ speaker: "business", text: "412." }], hotels);
    const [, input, schema] = required(complete.mock.calls[0]);
    expect(JSON.stringify(schema)).toContain("freeCancellation");
    expect(input).toBe("Business: 412.");
  });
});

describe("a live run end to end", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("turns the extracted quote into the same events as report_quote and books nobody", async () => {
    const fake = createFakeElevenLabs({ statuses: ["in-progress", "done"], transcript: sampleTranscript });
    const options = buildOptions(fake);
    const businesses = toSimBusinesses([{ name: "Harbour Inn", phone: ALLOWED }]);
    const industry = { ...hotels, simBusinesses: businesses };
    const events: AgentEvent[] = [];
    const stopListening = onEvent((event) => events.push(event));

    const report = await settle(
      runJob(liveJob(), industry, liveProvider(options), {
        maxParallelCalls: 1,
        decisionWindowMs: 120_000,
        runTimeoutMs: 120_000,
        settleGraceMs: 50,
        priceFlagPct: 10,
      }),
    );
    stopListening();

    const types = events.map((event) => event.type);
    expect(types.filter((type) => type === "transcript")).toHaveLength(3);
    expect(types).toContain("note");
    expect(types).toContain("quote");
    expect(types).not.toContain("decision_pushed");
    expect(report.decision.kind).toBe("commit");

    const summary = required(summarizeRun(events));
    expect(summary.provider).toBe("live");
    expect(summary.bookingConfirmed).toBeNull();
    expect(required(summary.winner).total).toBe(412);

    const call: CallOutcome = required(report.calls[0]);
    expect(existsSync(audioPath(options.runsDirectory, report.runId, call.callId))).toBe(true);
  });
});

describe("live settings", () => {
  const noLiveConfig: ProviderConfig = {
    OPENAI_API_KEY: undefined,
    OPENAI_MODEL: undefined,
    MAX_TURNS: 14,
    DECISION_WINDOW_MS: 2_000,
  };

  const fullConfig: ProviderConfig = {
    OPENAI_API_KEY: "sk-test",
    OPENAI_MODEL: "test-model",
    MAX_TURNS: 14,
    DECISION_WINDOW_MS: 2_000,
    ELEVENLABS_API_KEY: "key",
    ELEVENLABS_AGENT_ID: "agent",
    ELEVENLABS_PHONE_NUMBER_ID: "phone",
    LIVE_GUEST_NAME: "Jane Doe",
    LIVE_ALLOWED_NUMBERS: [ALLOWED],
    LIVE_MAX_CALLS: 6,
    LIVE_CALL_TIMEOUT_MS: 300_000,
  };

  it("names every missing setting and never its value", () => {
    expect(findMissingLiveSettings(noLiveConfig)).toEqual([
      "ELEVENLABS_API_KEY",
      "ELEVENLABS_AGENT_ID",
      "ELEVENLABS_PHONE_NUMBER_ID",
      "LIVE_GUEST_NAME",
      "OPENAI_API_KEY",
      "OPENAI_MODEL",
    ]);
    expect(() => createProvider("live", noLiveConfig)).toThrow("Live calls are unavailable");
  });

  it("builds a live provider once everything is set", () => {
    expect(findMissingLiveSettings(fullConfig)).toEqual([]);
    expect(createProvider("live", fullConfig).name).toBe("live");
  });
});

describe("live jobs", () => {
  it("never offers the examples subfolder as a job", () => {
    expect(listJobs("data/jobs").map((job) => job.id)).toEqual(["airport-rental", "toronto-weekend"]);
  });

  it("accepts the committed example with its stay and live businesses", () => {
    const job = loadJob(EXAMPLE_JOB_PATH);

    expect(job.stay).toEqual({ checkIn: "2026-11-20", checkOut: "2026-11-22", beds: "one king bed" });
    expect(job.liveBusinesses).toHaveLength(2);
  });

  it("gives each live business a file-safe id and keeps its phone off the name", () => {
    const businesses = toSimBusinesses([{ name: "Hôtel Le Germain!", phone: ALLOWED }]);

    const business = required(businesses[0]);
    expect(business.id).toMatch(/^[a-z0-9-]+$/);
    expect(business.phone).toBe(ALLOWED);
  });
});

describe("live runs through the API", () => {
  function buildApp(runsDirectory: string, jobsDirectory: string) {
    const registry = new RunRegistry();
    const stop = registry.start();
    const app = createApp({
      jobsDirectory,
      runsDirectory,
      publicDirectory: "public",
      runOptions: { maxParallelCalls: 3, decisionWindowMs: 2_000, runTimeoutMs: 5_000, settleGraceMs: 50, priceFlagPct: 10 },
      maxTurns: 14,
      createProvider: (name) => createProvider(name, { OPENAI_API_KEY: undefined, OPENAI_MODEL: undefined, MAX_TURNS: 14, DECISION_WINDOW_MS: 2_000 }),
      registry,
      liveLimits: { allowedNumbers: [ALLOWED], maxCalls: 6, callTimeoutMs: 60_000 },
    });

    return { app, stop };
  }

  it("explains which settings are missing before dialing anyone", async () => {
    const { app, stop } = buildApp(createTempDirectory(), "data/jobs");

    const response = await request(app).post("/api/runs").send({ jobId: "toronto-weekend", provider: "live" });
    stop();

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("ELEVENLABS_API_KEY");
  });

  it("serves a saved recording as audio", async () => {
    const runsDirectory = createTempDirectory();
    const { app, stop } = buildApp(runsDirectory, "data/jobs");
    mkdirSync(join(runsDirectory, "run-abc"), { recursive: true });
    writeFileSync(audioPath(runsDirectory, "run-abc", "call-harbour-inn-1"), new Uint8Array([73, 68, 51]));

    const found = await request(app).get("/api/runs/run-abc/calls/call-harbour-inn-1/audio");
    const missing = await request(app).get("/api/runs/run-abc/calls/call-other-2/audio");
    const unsafe = await request(app).get("/api/runs/run-abc/calls/..%2Fsecret/audio");
    stop();

    expect(found.status).toBe(200);
    expect(found.headers["content-type"]).toContain("audio/mpeg");
    expect(missing.status).toBe(404);
    expect(unsafe.status).toBe(400);
  });
});

describe("picker labels", () => {
  it("names the three modes Demo, Chats and Live call", () => {
    expect(PROVIDER_OPTIONS).toEqual([
      { value: "fake", label: "Demo" },
      { value: "text", label: "Chats" },
      { value: "live", label: "Live call" },
    ]);
  });
});
