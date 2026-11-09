import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stream } from "node:stream";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeSelfTestCall, showsSelfTest } from "../public/js/render/header.js";
import { RunRegistry } from "../src/api/registry";
import { readSelfTestNumber, SelfTestLimiter } from "../src/api/selfTest";
import { createApp } from "../src/app";
import type { AppOptions } from "../src/app";
import { emit, onEvent } from "../src/core/events";
import type { AgentEvent } from "../src/core/events";
import { getRunLogPath, startRecorder } from "../src/core/recorder";
import { listAllJobs } from "../src/jobs";
import { maskPhone, maskPhoneNumbers, maskStrings, normalizeNorthAmericanNumber } from "../src/privacy";
import { elevenLabsClient } from "../src/providers/elevenLabs";
import type { FetchFunction } from "../src/providers/elevenLabs";
import { findMissingLiveSettings } from "../src/providers/index";
import type { ProviderConfig } from "../src/providers/index";
import { liveProvider } from "../src/providers/live";
import type { LiveLimits } from "../src/providers/live";
import { createQuoteExtractor } from "../src/providers/quoteExtractor";
import type { CallProvider } from "../src/providers/types";

// Only numbers reserved for fiction (555-0100 to 555-0199) appear in tests.
const TEST_NUMBER = "+14165550123";
const TEST_FORMATTED = "(416) 555-0123";
const TEST_DIGITS = "4165550123";
const MASKED = "+1 ••• ••• ••23";
const OTHER_NUMBER = "+14165550188";
const OTHER_DIGITS = "4165550188";
const HOUR_MS = 60 * 60 * 1000;

const tempDirectories: string[] = [];
const stoppers: (() => void)[] = [];

function createTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "quotedesk-privacy-"));
  tempDirectories.push(directory);
  return directory;
}

function writeJob(directory: string, fileName: string, job: Record<string, unknown>): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, fileName), JSON.stringify(job));
}

function privateHotelJob(phone: string): Record<string, unknown> {
  return {
    id: "my-hotels",
    industryId: "hotels",
    title: "My hotels",
    request: "a room for 2 guests",
    stay: { checkIn: "2026-11-20", checkOut: "2026-11-22", beds: "one king bed" },
    liveBusinesses: [{ name: "Corner Hotel", phone }],
  };
}

afterEach(() => {
  vi.restoreAllMocks();

  for (const stop of stoppers.splice(0)) {
    stop();
  }

  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("test number validation", () => {
  it("accepts North American numbers written with spaces, dashes, dots or brackets", () => {
    const written = [
      "+14165550123",
      "+1 416 555 0123",
      "+1 (416) 555-0123",
      "+1-416-555-0123",
      "+1.416.555.0123",
      " +1 (416)555 0123 ",
      "4165550123",
      "416 555 0123",
      "(416) 555-0123",
    ];

    for (const input of written) {
      expect(normalizeNorthAmericanNumber(input)).toBe(TEST_NUMBER);
    }
  });

  it("refuses numbers that are malformed", () => {
    const malformed = [
      "416 555 012",
      "14165550123",
      "+1 416 555 012",
      "+1 416 555 01234",
      "+1 016 555 0123",
      "+1 116 555 0123",
      "+1 416 555 0123 ext 4",
      "call me",
      "",
    ];

    for (const input of malformed) {
      expect(normalizeNorthAmericanNumber(input)).toBeNull();
    }
  });

  it("refuses numbers outside North America", () => {
    for (const input of ["+44 20 5550 0123", "+33 1 55 50 01 23", "+61 4 5550 0123"]) {
      expect(normalizeNorthAmericanNumber(input)).toBeNull();
    }
  });

  it("explains a bad number using only its masked form", () => {
    const result = readSelfTestNumber("+44 20 5550 0123");

    expect(result).toEqual({
      ok: false,
      error: "+1 ••• ••• ••23 is not a North American number. Enter 10 digits, with or without +1.",
    });
  });

  it("asks before dialing with the masked number only", () => {
    expect(describeSelfTestCall(TEST_NUMBER)).toBe(`Call ${MASKED} once to test?`);
  });
});

describe("masking", () => {
  it("masks every way a number can be written", () => {
    const text = `a ${TEST_NUMBER} b ${TEST_FORMATTED} c ${TEST_DIGITS} d +1 416 555 0123 e`;

    expect(maskPhoneNumbers(text)).toBe(`a ${MASKED} b ${MASKED} c ${MASKED} d ${MASKED} e`);
    expect(maskPhone(TEST_NUMBER)).toBe(MASKED);
  });

  it("leaves prices, dates and run ids alone", () => {
    const text = "Total $1,234 on 2026-11-20 for run-2026-11-09T02-00-27-638Z, 4 nights";

    expect(maskPhoneNumbers(text)).toBe(text);
  });

  it("masks strings deep inside objects without touching numbers", () => {
    const masked = maskStrings({ notes: [`Call ${TEST_NUMBER}`], total: 412 });

    expect(masked).toEqual({ notes: [`Call ${MASKED}`], total: 412 });
  });

  it("masks numbers in every event before a listener or the run log sees it", () => {
    const directory = createTempDirectory();
    const received: AgentEvent[] = [];
    stoppers.push(onEvent((event) => received.push(event)));
    stoppers.push(startRecorder(directory));

    emit({
      type: "note",
      runId: "run-privacy",
      at: 1,
      callId: "call-a",
      businessId: "a",
      text: `Their direct line is ${TEST_NUMBER}`,
    });

    const logged = readFileSync(getRunLogPath(directory, "run-privacy"), "utf8");
    expect(JSON.stringify(received)).toContain(MASKED);
    expect(JSON.stringify(received)).not.toContain(TEST_DIGITS);
    expect(logged).toContain(MASKED);
    expect(logged).not.toContain(TEST_DIGITS);
  });
});

describe("private jobs", () => {
  it("lists local jobs after the committed ones and marks them private", () => {
    const privateDirectory = join(createTempDirectory(), "jobs");
    writeJob(privateDirectory, "mine.json", privateHotelJob(OTHER_NUMBER));

    const listed = listAllJobs("data/jobs", privateDirectory);

    expect(listed.map((entry) => [entry.job.id, entry.isPrivate])).toEqual([
      ["airport-rental", false],
      ["toronto-weekend", false],
      ["my-hotels", true],
    ]);
  });

  it("works without a local folder", () => {
    const missing = join(createTempDirectory(), "no-such-folder");

    expect(listAllJobs("data/jobs", missing)).toHaveLength(2);
  });

  it("refuses a private job that reuses a committed id", () => {
    const privateDirectory = join(createTempDirectory(), "jobs");
    writeJob(privateDirectory, "copy.json", { ...privateHotelJob(OTHER_NUMBER), id: "toronto-weekend" });

    expect(() => listAllJobs("data/jobs", privateDirectory)).toThrow('use the id "toronto-weekend"');
  });
});

describe("self test switch and limit", () => {
  it("only shows Call me to test in Live call mode with the switch on", () => {
    expect(showsSelfTest("live", true)).toBe(true);
    expect(showsSelfTest("live", false)).toBe(false);
    expect(showsSelfTest("fake", true)).toBe(false);
    expect(showsSelfTest("text", true)).toBe(false);
  });

  it("allows three test runs an hour, then says when the next one frees up", () => {
    let now = 0;
    const limiter = new SelfTestLimiter(() => now);

    expect(limiter.take()).toEqual({ ok: true });
    now = 10 * 60 * 1000;
    expect(limiter.take()).toEqual({ ok: true });
    expect(limiter.take()).toEqual({ ok: true });

    expect(limiter.take()).toEqual({
      ok: false,
      error: "Only 3 test calls are allowed per hour. Try again in 50 minutes.",
    });

    now = HOUR_MS;
    expect(limiter.take()).toEqual({ ok: true });
  });

  it("turns live mode on with only the ElevenLabs and OpenAI settings", () => {
    const config: ProviderConfig = {
      OPENAI_API_KEY: "sk-test",
      OPENAI_MODEL: "test-model",
      MAX_TURNS: 14,
      DECISION_WINDOW_MS: 2_000,
      ELEVENLABS_API_KEY: "key",
      ELEVENLABS_AGENT_ID: "agent",
      ELEVENLABS_PHONE_NUMBER_ID: "phone",
      LIVE_GUEST_NAME: "Jane Doe",
      LIVE_ALLOWED_NUMBERS: [],
    };

    expect(findMissingLiveSettings(config)).toEqual([]);
  });
});

type FakeCallOptions = {
  transcriptLine: string;
  note: string;
};

// One call that answers, says the number out loud, and ends.
function createFakeLiveProvider(
  runsDirectory: string,
  allowedNumbers: string[],
  options: FakeCallOptions,
): CallProvider {
  async function fakeFetch(input: string | URL | Request): Promise<Response> {
    const url = String(input);

    if (url.endsWith("/twilio/outbound-call")) {
      return Response.json({ success: true, message: "ok", conversation_id: "conv-1", callSid: "CA1" });
    }

    if (url.endsWith("/audio")) {
      return new Response(new Uint8Array([1, 2, 3]));
    }

    const transcript = [
      { role: "user", message: options.transcriptLine, time_in_call_secs: 1 },
      { role: "agent", message: "Thanks, goodbye.", time_in_call_secs: 3 },
    ];
    return Response.json({ status: "done", transcript });
  }

  const reply = JSON.stringify({ quote: { total: 400 }, notes: [options.note] });

  return liveProvider({
    client: elevenLabsClient({ apiKey: "k", agentId: "a", phoneNumberId: "p", fetch: fakeFetch as FetchFunction }),
    extractQuote: createQuoteExtractor(async () => reply),
    guestName: "Jane Doe",
    allowedNumbers,
    maxCalls: 6,
    callTimeoutMs: 10_000,
    runsDirectory,
    pollMs: 5,
    spacingMs: 0,
  });
}

type PrivacyAppSettings = {
  liveLimits: LiveLimits | undefined;
  privateJobsDirectory: string;
  selfTestLimiter?: SelfTestLimiter;
};

function buildPrivacyApp(settings: PrivacyAppSettings) {
  const runsDirectory = createTempDirectory();
  const registry = new RunRegistry();
  stoppers.push(registry.start());
  stoppers.push(startRecorder(runsDirectory));

  let allowedNumbers: string[] = [];

  if (settings.liveLimits !== undefined) {
    allowedNumbers = settings.liveLimits.allowedNumbers;
  }

  const callOptions = {
    transcriptLine: `Sure. Our direct line is ${TEST_FORMATTED}, and it's 400 total.`,
    note: `Direct line ${TEST_NUMBER}.`,
  };

  function createTestProvider(): CallProvider {
    return createFakeLiveProvider(runsDirectory, allowedNumbers, callOptions);
  }

  const options: AppOptions = {
    jobsDirectory: "data/jobs",
    privateJobsDirectory: settings.privateJobsDirectory,
    runsDirectory,
    publicDirectory: "public",
    runOptions: { maxParallelCalls: 3, decisionWindowMs: 2_000, runTimeoutMs: 5_000, settleGraceMs: 10, priceFlagPct: 10 },
    maxTurns: 14,
    createProvider: createTestProvider,
    registry,
    liveLimits: settings.liveLimits,
    selfTestLimiter: settings.selfTestLimiter,
  };

  return { app: createApp(options), registry, runsDirectory };
}

// supertest doesn't buffer event streams by default, so the body is collected by hand.
function collectText(response: Stream, callback: (error: Error | null, body: string) => void): void {
  let body = "";

  response.on("data", (chunk: Buffer) => {
    body += chunk.toString();
  });
  response.on("end", () => {
    callback(null, body);
  });
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

function startSelfTest(app: ReturnType<typeof createApp>, testNumber: string) {
  return request(app).post("/api/runs").send({ jobId: "toronto-weekend", provider: "live", testNumber });
}

// Test numbers skip the allowlist, so it stays empty here.
const selfTestLimits: LiveLimits = {
  allowedNumbers: [],
  maxCalls: 6,
  callTimeoutMs: 10_000,
  selfTest: true,
};

describe("the browser API never returns a full number", () => {
  it("lists private jobs as (private) and reports whether Call me to test is on", async () => {
    const privateDirectory = join(createTempDirectory(), "jobs");
    writeJob(privateDirectory, "mine.json", privateHotelJob(OTHER_NUMBER));
    const { app } = buildPrivacyApp({ liveLimits: selfTestLimits, privateJobsDirectory: privateDirectory });

    const response = await request(app).get("/api/jobs");

    expect(response.body.selfTest).toBe(true);
    expect(response.body.jobs[2]).toMatchObject({ id: "my-hotels", title: "My hotels (private)", isPrivate: true });
    expect(response.text).not.toContain(OTHER_DIGITS);
  });

  it("names a refused business without its number", async () => {
    const privateDirectory = join(createTempDirectory(), "jobs");
    writeJob(privateDirectory, "mine.json", privateHotelJob(OTHER_NUMBER));
    const { app } = buildPrivacyApp({ liveLimits: selfTestLimits, privateJobsDirectory: privateDirectory });

    const response = await request(app).post("/api/runs").send({ jobId: "my-hotels", provider: "live" });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Corner Hotel is not on LIVE_ALLOWED_NUMBERS");
    expect(response.text).not.toContain(OTHER_DIGITS);
  });

  it("refuses a bad test number with a masked error", async () => {
    const { app } = buildPrivacyApp({ liveLimits: selfTestLimits, privateJobsDirectory: createTempDirectory() });

    const response = await startSelfTest(app, "+44 20 5550 0123");

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("is not a North American number");
    expect(response.text).not.toContain("5550 0123");
    expect(response.text).not.toContain("55500123");
  });

  it("masks a test call everywhere: events, stream, run log, summary, export and server logs", async () => {
    const consoleLines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => consoleLines.push(parts.join(" ")));
    vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => consoleLines.push(parts.join(" ")));
    const { app, registry, runsDirectory } = buildPrivacyApp({
      liveLimits: selfTestLimits,
      privateJobsDirectory: createTempDirectory(),
    });

    const started = await startSelfTest(app, "+1 (416) 555-0123");
    expect(started.status).toBe(201);

    const runId: string = started.body.runId;
    const summary = await waitForSummary(app, runId);
    const stream = await request(app).get(`/api/runs/${runId}/events`).buffer(true).parse(collectText);
    let events: AgentEvent[] = [];
    const recorded = registry.getEvents(runId);

    if (recorded !== undefined) {
      events = recorded;
    }

    const eventsText = JSON.stringify(events);
    const logText = readFileSync(getRunLogPath(runsDirectory, runId), "utf8");
    const runStarted = events.find((event) => event.type === "run_started");

    expect(runStarted).toMatchObject({ businesses: [{ name: "Test call", maskedPhone: MASKED }] });
    expect(eventsText).toContain(`Our direct line is ${MASKED}`);
    expect(summary.body.winner).toMatchObject({ businessName: "Test call", total: 400 });

    for (const text of [eventsText, String(stream.body), logText, summary.text, started.text, consoleLines.join("\n")]) {
      expect(text).not.toContain(TEST_DIGITS);
      expect(text).not.toContain("555-0123");
    }
  });

  it("runs a test call on a committed job, typed as 10 digits without +1", async () => {
    const { app, registry } = buildPrivacyApp({ liveLimits: selfTestLimits, privateJobsDirectory: createTempDirectory() });

    const started = await startSelfTest(app, "416 555 0123");
    expect(started.status).toBe(201);
    await waitForSummary(app, started.body.runId);

    const events = registry.getEvents(started.body.runId);
    expect(events).toBeDefined();
    const runStarted = (events as AgentEvent[]).find((event) => event.type === "run_started");
    expect(runStarted).toMatchObject({ businesses: [{ name: "Test call", maskedPhone: MASKED }] });
  });

  it("ignores a private job's businesses on a test call and rings only the test number", async () => {
    const privateDirectory = join(createTempDirectory(), "jobs");
    writeJob(privateDirectory, "mine.json", privateHotelJob(OTHER_NUMBER));
    const { app, registry } = buildPrivacyApp({ liveLimits: selfTestLimits, privateJobsDirectory: privateDirectory });

    const started = await request(app)
      .post("/api/runs")
      .send({ jobId: "my-hotels", provider: "live", testNumber: TEST_NUMBER });
    expect(started.status).toBe(201);
    await waitForSummary(app, started.body.runId);

    const events = registry.getEvents(started.body.runId) as AgentEvent[];
    const runStarted = events.find((event) => event.type === "run_started");
    expect(runStarted).toMatchObject({ businesses: [{ id: "test-call", name: "Test call" }] });
    expect(JSON.stringify(events)).not.toContain("Corner Hotel");
  });

  it("still refuses a normal live run on a committed job", async () => {
    const { app } = buildPrivacyApp({ liveLimits: selfTestLimits, privateJobsDirectory: createTempDirectory() });

    const response = await request(app).post("/api/runs").send({ jobId: "toronto-weekend", provider: "live" });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Live calls only use private jobs from local/jobs");
  });

  it("refuses a test number when LIVE_SELF_TEST is off, and hides the option", async () => {
    const { app } = buildPrivacyApp({
      liveLimits: { ...selfTestLimits, selfTest: false },
      privateJobsDirectory: createTempDirectory(),
    });

    const listing = await request(app).get("/api/jobs");
    const response = await startSelfTest(app, TEST_NUMBER);

    expect(listing.body.selfTest).toBe(false);
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("LIVE_SELF_TEST=false");
    expect(response.text).not.toContain(TEST_DIGITS);
  });

  it("refuses a test number outside Live call mode", async () => {
    const { app } = buildPrivacyApp({ liveLimits: selfTestLimits, privateJobsDirectory: createTempDirectory() });

    const response = await request(app)
      .post("/api/runs")
      .send({ jobId: "toronto-weekend", provider: "fake", testNumber: TEST_NUMBER });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("only works in Live call mode");
  });

  it("returns 429 once the hour's test calls are used up, without spending one on a bad number", async () => {
    const limiter = new SelfTestLimiter();
    limiter.take();
    limiter.take();
    const { app } = buildPrivacyApp({
      liveLimits: selfTestLimits,
      privateJobsDirectory: createTempDirectory(),
      selfTestLimiter: limiter,
    });

    const badNumber = await startSelfTest(app, "+1 416 555");
    expect(badNumber.status).toBe(400);

    const third = await startSelfTest(app, TEST_NUMBER);
    expect(third.status).toBe(201);
    await waitForSummary(app, third.body.runId);

    const fourth = await startSelfTest(app, TEST_NUMBER);
    expect(fourth.status).toBe(429);
    expect(fourth.body.error).toContain("Only 3 test calls are allowed per hour");
    expect(fourth.text).not.toContain(TEST_DIGITS);
  });
});
