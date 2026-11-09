import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stream } from "node:stream";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { showsTestCall } from "../public/js/render/header.js";
import { RunRegistry } from "../src/api/registry";
import { createApp } from "../src/app";
import type { AppOptions } from "../src/app";
import { emit, onEvent } from "../src/core/events";
import type { AgentEvent } from "../src/core/events";
import { getRunLogPath, startRecorder } from "../src/core/recorder";
import { listAllJobs } from "../src/jobs";
import { maskPhone, maskPhoneNumbers, maskStrings } from "../src/privacy";
import { elevenLabsClient } from "../src/providers/elevenLabs";
import type { FetchFunction } from "../src/providers/elevenLabs";
import { findMissingLiveSettings, listAllowedLiveNumbers } from "../src/providers/index";
import type { ProviderConfig } from "../src/providers/index";
import { liveProvider } from "../src/providers/live";
import type { LiveLimits } from "../src/providers/live";
import { createQuoteExtractor } from "../src/providers/quoteExtractor";
import type { CallProvider } from "../src/providers/types";

// Built at runtime, so the test file itself never holds a real-looking number.
const REAL_LOOKING = ["+1", "999", "321", "4567"].join("");
const REAL_FORMATTED = ["(999)", "321-4567"].join(" ");
const SECRET_DIGITS = ["321", "4567"].join("");
const MASKED = "+1 ••• ••• ••67";
const PLACEHOLDER = "+15555550123";

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
  for (const stop of stoppers.splice(0)) {
    stop();
  }

  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("masking", () => {
  it("masks every way a number can be written", () => {
    const text = `a ${REAL_LOOKING} b ${REAL_FORMATTED} c ${REAL_LOOKING.slice(2)} d`;

    expect(maskPhoneNumbers(text)).toBe(`a ${MASKED} b ${MASKED} c ${MASKED} d`);
    expect(maskPhone(REAL_LOOKING)).toBe(MASKED);
  });

  it("leaves prices, dates and run ids alone", () => {
    const text = "Total $1,234 on 2026-11-20 for run-2026-11-09T02-00-27-638Z, 4 nights";

    expect(maskPhoneNumbers(text)).toBe(text);
  });

  it("masks strings deep inside objects without touching numbers", () => {
    const masked = maskStrings({ notes: [`Call ${REAL_LOOKING}`], total: 412 });

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
      text: `Their direct line is ${REAL_LOOKING}`,
    });

    const logged = readFileSync(getRunLogPath(directory, "run-privacy"), "utf8");
    expect(JSON.stringify(received)).toContain(MASKED);
    expect(JSON.stringify(received)).not.toContain(SECRET_DIGITS);
    expect(logged).not.toContain(SECRET_DIGITS);
  });
});

describe("private jobs", () => {
  it("lists local jobs after the committed ones and marks them private", () => {
    const privateDirectory = join(createTempDirectory(), "jobs");
    writeJob(privateDirectory, "mine.json", privateHotelJob(PLACEHOLDER));

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
    writeJob(privateDirectory, "copy.json", { ...privateHotelJob(PLACEHOLDER), id: "toronto-weekend" });

    expect(() => listAllJobs("data/jobs", privateDirectory)).toThrow('use the id "toronto-weekend"');
  });
});

describe("LIVE_TEST_NUMBER", () => {
  const baseConfig: ProviderConfig = {
    OPENAI_API_KEY: "sk-test",
    OPENAI_MODEL: "test-model",
    MAX_TURNS: 14,
    DECISION_WINDOW_MS: 2_000,
    ELEVENLABS_API_KEY: "key",
    ELEVENLABS_AGENT_ID: "agent",
    ELEVENLABS_PHONE_NUMBER_ID: "phone",
    LIVE_GUEST_NAME: "Jane Doe",
  };

  it("is allowed without being repeated in LIVE_ALLOWED_NUMBERS", () => {
    const config = { ...baseConfig, LIVE_ALLOWED_NUMBERS: [PLACEHOLDER], LIVE_TEST_NUMBER: REAL_LOOKING };

    expect(listAllowedLiveNumbers(config)).toEqual([PLACEHOLDER, REAL_LOOKING]);
  });

  it("is listed once when it is also in LIVE_ALLOWED_NUMBERS", () => {
    const config = { ...baseConfig, LIVE_ALLOWED_NUMBERS: [REAL_LOOKING], LIVE_TEST_NUMBER: REAL_LOOKING };

    expect(listAllowedLiveNumbers(config)).toEqual([REAL_LOOKING]);
  });

  it("is enough on its own to turn live mode on", () => {
    const config = { ...baseConfig, LIVE_ALLOWED_NUMBERS: [], LIVE_TEST_NUMBER: REAL_LOOKING };

    expect(findMissingLiveSettings(config)).toEqual([]);
  });

  it("only shows the test option in Live call mode with a number set", () => {
    expect(showsTestCall("live", true)).toBe(true);
    expect(showsTestCall("live", false)).toBe(false);
    expect(showsTestCall("fake", true)).toBe(false);
    expect(showsTestCall("text", true)).toBe(false);
  });
});

type FakeCallOptions = {
  transcriptLine: string;
  note: string;
};

// One call that answers, says the number out loud, and ends.
function createFakeLiveProvider(runsDirectory: string, options: FakeCallOptions): CallProvider {
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
    allowedNumbers: [REAL_LOOKING],
    maxCalls: 6,
    callTimeoutMs: 10_000,
    runsDirectory,
    pollMs: 5,
    spacingMs: 0,
  });
}

function buildPrivacyApp(liveLimits: LiveLimits | undefined, privateJobsDirectory: string) {
  const runsDirectory = createTempDirectory();
  const registry = new RunRegistry();
  stoppers.push(registry.start());
  stoppers.push(startRecorder(runsDirectory));

  const callOptions = {
    transcriptLine: `Sure. Our direct line is ${REAL_FORMATTED}, and it's 400 total.`,
    note: `Direct line ${REAL_LOOKING}.`,
  };

  function createTestProvider(): CallProvider {
    return createFakeLiveProvider(runsDirectory, callOptions);
  }

  const options: AppOptions = {
    jobsDirectory: "data/jobs",
    privateJobsDirectory,
    runsDirectory,
    publicDirectory: "public",
    runOptions: { maxParallelCalls: 3, decisionWindowMs: 2_000, runTimeoutMs: 5_000, settleGraceMs: 10, priceFlagPct: 10 },
    maxTurns: 14,
    createProvider: createTestProvider,
    registry,
    liveLimits,
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

describe("the browser API never returns a full number", () => {
  const limits: LiveLimits = {
    allowedNumbers: [REAL_LOOKING],
    maxCalls: 6,
    callTimeoutMs: 10_000,
    testNumber: REAL_LOOKING,
  };

  it("lists private jobs as (private) and says only that a test number exists", async () => {
    const privateDirectory = join(createTempDirectory(), "jobs");
    writeJob(privateDirectory, "mine.json", privateHotelJob(REAL_LOOKING));
    const { app } = buildPrivacyApp(limits, privateDirectory);

    const response = await request(app).get("/api/jobs");

    expect(response.body.liveTestCall).toBe(true);
    expect(response.body.jobs[2]).toMatchObject({ id: "my-hotels", title: "My hotels (private)", isPrivate: true });
    expect(response.text).not.toContain(SECRET_DIGITS);
  });

  it("hides the test option when LIVE_TEST_NUMBER isn't set", async () => {
    const { app } = buildPrivacyApp({ ...limits, testNumber: undefined }, createTempDirectory());

    const response = await request(app).get("/api/jobs");

    expect(response.body.liveTestCall).toBe(false);
  });

  it("refuses live calls to a committed job, which can't hold real numbers", async () => {
    const { app } = buildPrivacyApp(limits, createTempDirectory());

    const response = await request(app).post("/api/runs").send({ jobId: "toronto-weekend", provider: "live" });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("private jobs from local/jobs");
  });

  it("names a refused business without its number", async () => {
    const privateDirectory = join(createTempDirectory(), "jobs");
    const unlisted = ["+1", "999", "321", "4500"].join("");
    writeJob(privateDirectory, "mine.json", privateHotelJob(unlisted));
    const { app } = buildPrivacyApp(limits, privateDirectory);

    const response = await request(app).post("/api/runs").send({ jobId: "my-hotels", provider: "live" });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Corner Hotel is not on LIVE_ALLOWED_NUMBERS");
    expect(response.text).not.toContain("3214500");
  });

  it("masks a test call everywhere: events, stream, run log, summary and export", async () => {
    const { app, registry, runsDirectory } = buildPrivacyApp(limits, createTempDirectory());

    const started = await request(app)
      .post("/api/runs")
      .send({ jobId: "toronto-weekend", provider: "live", testCall: true });
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

    for (const text of [eventsText, String(stream.body), logText, summary.text]) {
      expect(text).not.toContain(SECRET_DIGITS);
    }
  });
});
