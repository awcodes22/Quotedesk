import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stream } from "node:stream";
import request from "supertest";
import type { Response } from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { RunRegistry } from "../src/api/registry";
import { summarizeRun } from "../src/api/summary";
import { createApp } from "../src/app";
import { onEvent } from "../src/core/events";
import type { AgentEvent } from "../src/core/events";
import { getRunLogPath } from "../src/core/recorder";
import { runJob } from "../src/core/run";
import { hotels } from "../src/industries/hotels";
import { loadJob } from "../src/jobs";
import { fakeProvider } from "../src/providers/fake";
import type { FakeProviderOptions } from "../src/providers/fake";
import { createProvider } from "../src/providers/index";
import type { CallProvider } from "../src/providers/types";

type ParsedStream = {
  events: AgentEvent[];
  ended: boolean;
};

const stoppers: (() => void)[] = [];
const tempDirectories: string[] = [];

const noOpenAIConfig = {
  OPENAI_API_KEY: undefined,
  OPENAI_MODEL: undefined,
  MAX_TURNS: 14,
  DECISION_WINDOW_MS: 2_000,
};

function createTestProvider(
  name: string,
  fakeOptions: FakeProviderOptions = {},
): CallProvider {
  if (name === "fake") {
    return fakeProvider({ ...fakeOptions, stepMs: 1 });
  }

  return createProvider(name, noOpenAIConfig);
}

function createTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "quotedesk-api-"));
  tempDirectories.push(directory);
  return directory;
}

function buildTestApp(runsDirectory: string) {
  const registry = new RunRegistry();
  stoppers.push(registry.start());

  const app = createApp({
    jobsDirectory: "data/jobs",
    runsDirectory,
    publicDirectory: "public",
    runOptions: {
      maxParallelCalls: 3,
      decisionWindowMs: 2_000,
      runTimeoutMs: 5_000,
      settleGraceMs: 50,
      priceFlagPct: 10,
    },
    maxTurns: 14,
    createProvider: createTestProvider,
    registry,
  });

  return { app, registry };
}

function parseStream(text: string): ParsedStream {
  const blocks = text.split("\n\n").filter((block) => block.trim() !== "");
  const events: AgentEvent[] = [];
  let ended = false;

  for (const block of blocks) {
    if (block.startsWith("event: end")) {
      ended = true;
    } else if (block.startsWith("data: ")) {
      const json = block.slice("data: ".length);
      events.push(JSON.parse(json) as AgentEvent);
    }
  }

  return { events, ended };
}

// supertest doesn't buffer event streams by default, so the body is collected by hand.
function collectText(
  response: Stream,
  callback: (error: Error | null, body: string) => void,
): void {
  let body = "";

  response.on("data", (chunk: Buffer) => {
    body += chunk.toString();
  });
  response.on("end", () => {
    callback(null, body);
  });
}

async function readEventStream(
  app: ReturnType<typeof buildTestApp>["app"],
  runId: string,
): Promise<ParsedStream> {
  const response: Response = await request(app)
    .get(`/api/runs/${runId}/events`)
    .buffer(true)
    .parse(collectText);

  expect(response.status).toBe(200);
  expect(response.headers["content-type"]).toContain("text/event-stream");
  return parseStream(String(response.body));
}

async function startFakeRun(
  app: ReturnType<typeof buildTestApp>["app"],
  jobId: string,
): Promise<string> {
  const response = await request(app)
    .post("/api/runs")
    .send({ jobId, provider: "fake" });

  expect(response.status).toBe(201);
  return String(response.body.runId);
}

afterEach(() => {
  for (const stop of stoppers.splice(0)) {
    stop();
  }

  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("GET /api/jobs", () => {
  it("lists every job file with what the dashboard needs", async () => {
    const { app } = buildTestApp(createTempDirectory());

    const response = await request(app).get("/api/jobs");

    expect(response.status).toBe(200);
    expect(response.body.jobs).toHaveLength(2);
    expect(response.body.jobs[0]).toMatchObject({
      id: "airport-rental",
      title: "3-day airport rental",
      industry: { id: "car-rentals", label: "Car rentals" },
      reference: { total: 246, source: "Last trip's receipt" },
      details: [
        { label: "Dates", value: "Nov 20 to 23 · 3 days", icon: "calendar" },
        { label: "Pick-up", value: "Toronto Pearson", icon: "map-pin" },
      ],
      decideWithinMs: 5_000,
      maxTurns: 14,
      contactName: "Jane Doe",
      businessCount: 3,
    });
  });

  it("doesn't expose the contact email", async () => {
    const { app } = buildTestApp(createTempDirectory());

    const response = await request(app).get("/api/jobs");

    expect(response.text).not.toContain("@example.com");
  });
});

describe("POST /api/runs", () => {
  it("starts a fake run and returns its id", async () => {
    const { app } = buildTestApp(createTempDirectory());

    const runId = await startFakeRun(app, "toronto-weekend");

    expect(runId).toMatch(/^run-/);
    await readEventStream(app, runId);
  });

  it("rejects a body that doesn't match the schema", async () => {
    const { app } = buildTestApp(createTempDirectory());

    const response = await request(app)
      .post("/api/runs")
      .send({ jobId: "toronto-weekend", provider: "voice" });

    expect(response.status).toBe(400);
  });

  it("rejects malformed JSON with a 400", async () => {
    const { app } = buildTestApp(createTempDirectory());

    const response = await request(app)
      .post("/api/runs")
      .set("Content-Type", "application/json")
      .send("{not json");

    expect(response.status).toBe(400);
  });

  it("returns 404 for an unknown job", async () => {
    const { app } = buildTestApp(createTempDirectory());

    const response = await request(app)
      .post("/api/runs")
      .send({ jobId: "no-such-job", provider: "fake" });

    expect(response.status).toBe(404);
  });

  it("explains a text provider without OpenAI settings", async () => {
    const { app } = buildTestApp(createTempDirectory());

    const response = await request(app)
      .post("/api/runs")
      .send({ jobId: "toronto-weekend", provider: "text" });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("OPENAI_API_KEY");
  });

  it("refuses a second run while one is active", async () => {
    const { app } = buildTestApp(createTempDirectory());
    const runId = await startFakeRun(app, "toronto-weekend");

    const second = await request(app)
      .post("/api/runs")
      .send({ jobId: "airport-rental", provider: "fake" });

    expect(second.status).toBe(409);
    await readEventStream(app, runId);
  });
});

describe("POST /api/runs with scale", () => {
  it("dials every scaled call at once", async () => {
    const { app } = buildTestApp(createTempDirectory());
    const response = await request(app)
      .post("/api/runs")
      .send({ jobId: "toronto-weekend", provider: "fake", scale: 24 });

    expect(response.status).toBe(201);

    const stream = await readEventStream(app, String(response.body.runId));
    const firstQuote = stream.events.findIndex((event) => event.type === "quote");
    const dialedBeforeFirstQuote = stream.events
      .slice(0, firstQuote)
      .filter((event) => event.type === "call_status" && event.status === "connecting");

    expect(stream.events[0]).toMatchObject({ type: "run_started" });
    expect(dialedBeforeFirstQuote).toHaveLength(24);
  });

  it("refuses scale for the text provider", async () => {
    const { app } = buildTestApp(createTempDirectory());

    const response = await request(app)
      .post("/api/runs")
      .send({ jobId: "toronto-weekend", provider: "text", scale: 24 });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("fake provider");
  });

  it("refuses a scale above the maximum", async () => {
    const { app } = buildTestApp(createTempDirectory());

    const response = await request(app)
      .post("/api/runs")
      .send({ jobId: "toronto-weekend", provider: "fake", scale: 500 });

    expect(response.status).toBe(400);
  });
});

describe("GET /api/runs/:id/events", () => {
  it("streams a run from run_started to run_finished, then ends", async () => {
    const { app, registry } = buildTestApp(createTempDirectory());
    const runId = await startFakeRun(app, "toronto-weekend");

    const stream = await readEventStream(app, runId);

    expect(stream.ended).toBe(true);
    expect(stream.events[0]).toMatchObject({ type: "run_started", runId });
    expect(stream.events.at(-1)).toMatchObject({ type: "run_finished" });
    expect(stream.events).toEqual(registry.getEvents(runId));
  });

  it("replays a finished run in the same order", async () => {
    const { app } = buildTestApp(createTempDirectory());
    const runId = await startFakeRun(app, "toronto-weekend");
    const live = await readEventStream(app, runId);

    const replay = await readEventStream(app, runId);

    expect(replay.ended).toBe(true);
    expect(replay.events).toEqual(live.events);
  });

  it("includes the decision countdown before the decision", async () => {
    const { app } = buildTestApp(createTempDirectory());
    const runId = await startFakeRun(app, "toronto-weekend");

    const stream = await readEventStream(app, runId);
    const types = stream.events.map((event) => event.type);
    const firstSchedule = types.indexOf("decision_scheduled");

    expect(firstSchedule).toBeGreaterThan(0);
    expect(firstSchedule).toBeLessThan(types.indexOf("decision"));
    expect(types.lastIndexOf("decision_scheduled")).toBeLessThan(
      types.indexOf("decision"),
    );
  });

  it("replays a run from its log file when it isn't in memory", async () => {
    const runsDirectory = createTempDirectory();
    const first = buildTestApp(runsDirectory);
    const runId = await startFakeRun(first.app, "toronto-weekend");
    const live = await readEventStream(first.app, runId);
    const lines = live.events.map((event) => JSON.stringify(event));
    writeFileSync(getRunLogPath(runsDirectory, runId), `${lines.join("\n")}\n`);
    const restarted = buildTestApp(runsDirectory);

    const replay = await readEventStream(restarted.app, runId);

    expect(replay.events).toEqual(live.events);
    expect(replay.ended).toBe(true);
  });

  it("returns 404 for an unknown run", async () => {
    const { app } = buildTestApp(createTempDirectory());

    const response = await request(app).get("/api/runs/run-unknown/events");

    expect(response.status).toBe(404);
  });

  it("refuses a run id that could leave the runs folder", async () => {
    const { app } = buildTestApp(createTempDirectory());

    const response = await request(app).get(
      "/api/runs/..%2F..%2Fpackage/events",
    );

    expect(response.status).toBe(400);
  });
});

describe("GET /api/runs/:id/summary", () => {
  it("summarises a finished fake run", async () => {
    const { app } = buildTestApp(createTempDirectory());
    const runId = await startFakeRun(app, "toronto-weekend");
    await readEventStream(app, runId);

    const response = await request(app).get(`/api/runs/${runId}/summary`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      runId,
      provider: "fake",
      industryLabel: "Hotel rooms",
      decision: { kind: "commit", reason: "all-settled" },
      winner: {
        rank: 1,
        businessId: "queen-west-suites",
        businessName: "Queen West Suites",
        total: 398,
        firstTotal: 455,
        outcome: "committed",
      },
      bookingConfirmed: true,
      counts: { calls: 3, quoted: 3, failed: 0, neverQuoted: 0 },
      stats: {
        best: 398,
        median: 412,
        savedVsMedian: 14,
        vsReferencePct: 14,
      },
      priceCheck: { flaggedCount: 1 },
    });
    expect(response.body.quotes.map((quote: { outcome: string }) => quote.outcome)).toEqual([
      "committed",
      "closed",
      "closed",
    ]);
    expect(
      response.body.milestones.map((milestone: { key: string }) => milestone.key),
    ).toEqual(["dialed", "first-quote", "decided", "finished"]);
  });

  it("returns 409 while the run is still going", async () => {
    const { app } = buildTestApp(createTempDirectory());
    const runId = await startFakeRun(app, "toronto-weekend");

    const response = await request(app).get(`/api/runs/${runId}/summary`);

    expect(response.status).toBe(409);
    await readEventStream(app, runId);
  });

  it("returns 404 for an unknown run", async () => {
    const { app } = buildTestApp(createTempDirectory());

    const response = await request(app).get("/api/runs/run-unknown/summary");

    expect(response.status).toBe(404);
  });
});

describe("summarizeRun", () => {
  async function summarizeHotelRun(
    businessIds: string[],
    failBusinessIds: string[],
  ) {
    const events: AgentEvent[] = [];
    stoppers.push(onEvent((event) => events.push(event)));
    const job = { ...loadJob("data/jobs/hotels.json"), businessIds };
    const provider = fakeProvider({ stepMs: 1, failBusinessIds });

    await runJob(job, hotels, provider, {
      maxParallelCalls: 3,
      decisionWindowMs: 2_000,
      runTimeoutMs: 5_000,
      settleGraceMs: 50,
      priceFlagPct: 10,
    });

    return summarizeRun(events);
  }

  it("takes the middle of two quotes as the median", async () => {
    const summary = await summarizeHotelRun(
      ["harbour-inn", "union-station-hotel"],
      [],
    );

    expect(summary).toMatchObject({
      stats: { best: 412, median: 421, savedVsMedian: 9 },
    });
  });

  it("counts a call that never answered as failed, not as never quoted", async () => {
    const summary = await summarizeHotelRun(
      ["harbour-inn", "union-station-hotel"],
      ["union-station-hotel"],
    );

    expect(summary).toMatchObject({
      bookingConfirmed: true,
      counts: { calls: 2, quoted: 1, failed: 1, neverQuoted: 0 },
      stats: { best: 412, median: 412, savedVsMedian: 0 },
    });
  });

  it("returns undefined for a run that hasn't finished", () => {
    expect(summarizeRun([])).toBeUndefined();
  });
});
