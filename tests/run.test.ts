import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { onEvent } from "../src/core/events";
import type { AgentEvent } from "../src/core/events";
import { isRunning, runJob } from "../src/core/run";
import type { RunOptions } from "../src/core/run";
import type { CallInstruction, CallOutcome, Job } from "../src/core/types";
import { carRentals } from "../src/industries/carRentals";
import { hotels } from "../src/industries/hotels";
import { listJobs, loadJob } from "../src/jobs";
import { fakeProvider } from "../src/providers/fake";
import type { CallContext, CallProvider } from "../src/providers/types";

const unsubscribers: (() => void)[] = [];
const tempDirectories: string[] = [];

const hotelJob: Job = {
  id: "test-hotel",
  industryId: "hotels",
  title: "Test stay",
  request: "A room for two nights.",
};

const carJob: Job = {
  id: "test-car",
  industryId: "car-rentals",
  title: "Test rental",
  request: "A midsize car for three days.",
};

const testOptions: RunOptions = {
  maxParallelCalls: 3,
  decisionWindowMs: 5_000,
  runTimeoutMs: 10_000,
  settleGraceMs: 200,
  priceFlagPct: 10,
};

const quickProvider = fakeProvider({ stepMs: 1 });

function collectEvents(): AgentEvent[] {
  const events: AgentEvent[] = [];
  const unsubscribe = onEvent((event) => {
    events.push(event);
  });
  unsubscribers.push(unsubscribe);
  return events;
}

function getPushes(events: AgentEvent[]) {
  return events.filter((event) => event.type === "decision_pushed");
}

function getAlertCodes(events: AgentEvent[]): string[] {
  const alerts = events.filter((event) => event.type === "alert");
  return alerts.map((alert) => alert.code);
}

function findEventIndex(events: AgentEvent[], type: AgentEvent["type"]): number {
  return events.findIndex((event) => event.type === type);
}

function countActiveTimers(): number {
  const resources = process.getActiveResourcesInfo();
  return resources.filter((resource) => resource === "Timeout").length;
}

function writeJobFile(contents: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "quotedesk-jobs-"));
  tempDirectories.push(directory);
  const path = join(directory, "job.json");
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

function buildCompletedOutcome(context: CallContext): CallOutcome {
  return {
    callId: context.callId,
    businessId: context.business.id,
    status: "completed",
    transcript: [],
    notes: [],
  };
}

function buildRefusingWinnerProvider(): CallProvider {
  function startCall(context: CallContext) {
    const handle = quickProvider.startCall(context);

    return {
      done: handle.done,
      send: () => {
        handle.send({ command: "close" });
        return false;
      },
    };
  }

  return { name: "refusing", startCall };
}

function buildRecordingProvider(sent: CallInstruction[]): CallProvider {
  function startCall(context: CallContext) {
    const handle = quickProvider.startCall(context);

    return {
      done: handle.done,
      send: (instruction: CallInstruction) => {
        sent.push(instruction);
        return handle.send(instruction);
      },
    };
  }

  return { name: "recording", startCall };
}

function buildBadQuoteProvider(): CallProvider {
  function startCall(context: CallContext) {
    context.reportQuote({ total: -1 });

    return {
      done: Promise.resolve(buildCompletedOutcome(context)),
      send: () => false,
    };
  }

  return { name: "bad-quote", startCall };
}

function buildCrashingProvider(): CallProvider {
  function startCall(): never {
    throw new Error("Provider crashed");
  }

  return { name: "crashing", startCall };
}

afterEach(() => {
  for (const unsubscribe of unsubscribers.splice(0)) {
    unsubscribe();
  }

  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("runJob with the fake provider", () => {
  it("picks Queen West Suites at 398 after its negotiated drop", async () => {
    const report = await runJob(hotelJob, hotels, quickProvider, testOptions);

    expect(report.decision).toMatchObject({
      kind: "commit",
      reason: "all-settled",
      winner: { businessId: "queen-west-suites", total: 398 },
    });
  });

  it("picks Harbourfront at 240 over Metro Drive's negotiated 243", async () => {
    const report = await runJob(carJob, carRentals, quickProvider, testOptions);

    expect(report.decision).toMatchObject({
      kind: "commit",
      winner: { businessId: "harbourfront-car-rentals", total: 240 },
      others: [
        { businessId: "metro-drive", total: 243 },
        { businessId: "northway-rentals", total: 275 },
      ],
    });
  });

  it("pushes exactly one commit and closes the rest", async () => {
    const events = collectEvents();

    const report = await runJob(hotelJob, hotels, quickProvider, testOptions);

    const pushes = getPushes(events);
    const commits = pushes.filter((push) => push.command === "commit");
    const closes = pushes.filter((push) => push.command === "close");

    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({
      businessId: "queen-west-suites",
      delivered: true,
    });
    expect(closes).toHaveLength(2);
    expect(report.calls.map((call) => call.command).sort()).toEqual([
      "close",
      "close",
      "commit",
    ]);
  });

  it("sends the winning quote with the commit and nothing with a close", async () => {
    const sent: CallInstruction[] = [];
    const provider = buildRecordingProvider(sent);

    const report = await runJob(hotelJob, hotels, provider, testOptions);

    expect(report.decision).toMatchObject({ kind: "commit" });

    if (report.decision.kind !== "commit") {
      throw new Error("The run should have picked a winner.");
    }

    expect(sent).toHaveLength(3);
    expect(sent).toContainEqual({
      command: "commit",
      quote: report.decision.winner,
    });
    expect(sent.filter((item) => item.command === "close")).toEqual([
      { command: "close" },
      { command: "close" },
    ]);
  });

  it("emits run_finished last", async () => {
    const events = collectEvents();

    const report = await runJob(hotelJob, hotels, quickProvider, testOptions);

    expect(events.at(-1)).toMatchObject({ type: "run_finished", report });
  });

  it("decides from the others when a business never answers", async () => {
    const provider = fakeProvider({
      stepMs: 1,
      failBusinessIds: ["queen-west-suites"],
    });

    const report = await runJob(hotelJob, hotels, provider, testOptions);

    expect(report.decision).toMatchObject({
      kind: "commit",
      winner: { businessId: "harbour-inn", total: 412 },
    });
    expect(report.calls).toContainEqual(
      expect.objectContaining({
        businessId: "queen-west-suites",
        status: "failed",
        error: "No answer",
      }),
    );
  });

  it("waits for the decision when every call fails", async () => {
    const provider = fakeProvider({
      stepMs: 1,
      failBusinessIds: hotels.simBusinesses.map((business) => business.id),
    });

    const report = await runJob(hotelJob, hotels, provider, testOptions);

    expect(report.decision).toEqual({ kind: "none", reason: "no-quotes" });
  });

  it("skips calls still queued at decision time", async () => {
    const events = collectEvents();
    const options = {
      ...testOptions,
      maxParallelCalls: 1,
      decisionWindowMs: 1,
    };

    const report = await runJob(hotelJob, hotels, quickProvider, options);

    const statuses = report.calls.map((call) => call.status);
    const skippedEvents = events.filter(
      (event) => event.type === "call_status" && event.status === "skipped",
    );

    expect(statuses).toEqual(["completed", "skipped", "skipped"]);
    expect(skippedEvents).toHaveLength(2);
    expect(report.decision).toMatchObject({
      winner: { businessId: "harbour-inn" },
    });
  });

  it("stops negotiating when the decision lands mid-call", async () => {
    const events = collectEvents();
    const options = { ...testOptions, decisionWindowMs: 1 };
    const provider = fakeProvider({ stepMs: 20 });

    await runJob(hotelJob, hotels, provider, options);

    expect(getAlertCodes(events)).not.toContain("BAD_QUOTE");
  });

  it("leaves no timers running after the run", async () => {
    const timersBefore = countActiveTimers();

    await runJob(hotelJob, hotels, quickProvider, testOptions);

    // Vitest's own timers can finish during the run, so only an increase is a leak.
    expect(countActiveTimers()).toBeLessThanOrEqual(timersBefore);
  });

  it("keeps the quote event ahead of the decision with no grace", async () => {
    const events = collectEvents();
    const job = { ...hotelJob, businessIds: ["harbour-inn"] };
    const options = { ...testOptions, settleGraceMs: 0 };

    await runJob(job, hotels, quickProvider, options);

    const quoteIndex = findEventIndex(events, "quote");
    const decisionIndex = findEventIndex(events, "decision");

    expect(quoteIndex).toBeGreaterThanOrEqual(0);
    expect(quoteIndex).toBeLessThan(decisionIndex);
  });
});

describe("runJob", () => {
  it("rejects a second run while one is active", async () => {
    const firstRun = runJob(hotelJob, hotels, quickProvider, testOptions);

    expect(isRunning()).toBe(true);
    await expect(
      runJob(hotelJob, hotels, quickProvider, testOptions),
    ).rejects.toThrow("already in progress");

    await firstRun;
    expect(isRunning()).toBe(false);
  });

  it("calls only the businesses named in the job", async () => {
    const job = { ...hotelJob, businessIds: ["harbour-inn"] };

    const report = await runJob(job, hotels, quickProvider, testOptions);

    expect(report.calls.map((call) => call.businessId)).toEqual([
      "harbour-inn",
    ]);
  });

  it("throws on an unknown business and stays available", async () => {
    const job = { ...hotelJob, businessIds: ["harbor-inn"] };

    await expect(
      runJob(job, hotels, quickProvider, testOptions),
    ).rejects.toThrow('Unknown business "harbor-inn"');
    expect(isRunning()).toBe(false);
  });

  it("throws when the industry has no businesses", async () => {
    const emptyIndustry = { ...hotels, simBusinesses: [] };

    await expect(
      runJob(hotelJob, emptyIndustry, quickProvider, testOptions),
    ).rejects.toThrow("no businesses to call");
  });

  it("raises WINNER_GONE when the commit can't be delivered", async () => {
    const events = collectEvents();
    const provider = buildRefusingWinnerProvider();

    await runJob(hotelJob, hotels, provider, testOptions);

    expect(getAlertCodes(events)).toContain("WINNER_GONE");
  });

  it("raises BAD_QUOTE for an invalid quote and records nothing", async () => {
    const events = collectEvents();
    const provider = buildBadQuoteProvider();

    const report = await runJob(hotelJob, hotels, provider, testOptions);

    expect(getAlertCodes(events)).toEqual([
      "BAD_QUOTE",
      "BAD_QUOTE",
      "BAD_QUOTE",
    ]);
    expect(report.decision).toEqual({ kind: "none", reason: "no-quotes" });
  });

  it("turns a provider crash into a failed call", async () => {
    const provider = buildCrashingProvider();

    const report = await runJob(hotelJob, hotels, provider, testOptions);

    expect(report.decision).toEqual({ kind: "none", reason: "no-quotes" });
    expect(report.calls.map((call) => call.status)).toEqual([
      "failed",
      "failed",
      "failed",
    ]);
    expect(isRunning()).toBe(false);
  });
});

describe("runJob price check", () => {
  it("emits price_check before run_finished for a car rental", async () => {
    const events = collectEvents();
    const job = loadJob("data/jobs/car-rentals.json");

    const report = await runJob(job, carRentals, quickProvider, testOptions);

    const checkIndex = findEventIndex(events, "price_check");
    const finishedIndex = findEventIndex(events, "run_finished");

    expect(checkIndex).toBeGreaterThanOrEqual(0);
    expect(checkIndex).toBe(finishedIndex - 1);
    expect(report.priceCheck).toMatchObject({
      businessId: "harbourfront-car-rentals",
      flaggedCount: 1,
    });
  });

  it("flags the Total row for a hotel run", async () => {
    const job = loadJob("data/jobs/hotels.json");

    const report = await runJob(job, hotels, quickProvider, testOptions);

    expect(report.priceCheck).toMatchObject({
      rows: [{ item: "Total", reference: 349, quoted: 398, flagged: true }],
    });
  });

  it("uses the threshold from the run options", async () => {
    const job = loadJob("data/jobs/hotels.json");
    const options = { ...testOptions, priceFlagPct: 20 };

    const report = await runJob(job, hotels, quickProvider, options);

    expect(report.priceCheck).toMatchObject({
      thresholdPct: 20,
      flaggedCount: 0,
    });
  });

  it("does nothing when the job has no reference", async () => {
    const events = collectEvents();

    const report = await runJob(hotelJob, hotels, quickProvider, testOptions);

    expect(findEventIndex(events, "price_check")).toBe(-1);
    expect(report).not.toHaveProperty("priceCheck");
  });

  it("does nothing when there is no winner", async () => {
    const events = collectEvents();
    const job = loadJob("data/jobs/hotels.json");

    const report = await runJob(
      job,
      hotels,
      buildCrashingProvider(),
      testOptions,
    );

    expect(findEventIndex(events, "price_check")).toBe(-1);
    expect(report).not.toHaveProperty("priceCheck");
  });
});

describe("jobs", () => {
  it("lists the job files", () => {
    const jobs = listJobs();

    expect(jobs.map((job) => job.id)).toEqual([
      "airport-rental",
      "toronto-weekend",
    ]);
  });

  it("names the file when a job is invalid", () => {
    const path = writeJobFile({ id: "broken", businessIDs: [] });

    expect(() => loadJob(path)).toThrow(`Invalid job file ${path}`);
  });

  it("keeps only placeholder contacts in the job files", () => {
    const jobs = listJobs();

    for (const job of jobs) {
      expect(job.contact).toEqual({
        name: "Jane Doe",
        email: "jane.doe@example.com",
      });
    }
  });

  it("rejects a badly formed contact email", () => {
    const contact = { name: "Jane Doe", email: "jane.doe-at-example" };
    const path = writeJobFile({ ...hotelJob, contact });

    expect(() => loadJob(path)).toThrow(`Invalid job file ${path}`);
  });

  it("rejects a contact with a missing name", () => {
    const contact = { email: "jane.doe@example.com" };
    const path = writeJobFile({ ...hotelJob, contact });

    expect(() => loadJob(path)).toThrow(`Invalid job file ${path}`);
  });

  it("rejects a misspelled reference field", () => {
    const path = writeJobFile({ ...hotelJob, reference: { totl: 349 } });

    expect(() => loadJob(path)).toThrow(`Invalid job file ${path}`);
  });

  it("rejects a zero reference price, which can't be compared", () => {
    const reference = { lines: { "daily rate": 0 } };
    const path = writeJobFile({ ...hotelJob, reference });

    expect(() => loadJob(path)).toThrow(`Invalid job file ${path}`);
  });

  it("reads the header details in the order the file lists them", () => {
    const job = loadJob("data/jobs/hotels.json");

    expect(job.details).toEqual([
      { label: "Dates", value: "Nov 20 to 22 · 2 nights" },
    ]);
  });

  it("rejects a detail with an empty value", () => {
    const details = [{ label: "Dates", value: "" }];
    const path = writeJobFile({ ...hotelJob, details });

    expect(() => loadJob(path)).toThrow(`Invalid job file ${path}`);
  });

  it("rejects a detail with an unknown key", () => {
    const details = [{ label: "Dates", value: "Nov 20", icon: "calendar" }];
    const path = writeJobFile({ ...hotelJob, details });

    expect(() => loadJob(path)).toThrow(`Invalid job file ${path}`);
  });
});
