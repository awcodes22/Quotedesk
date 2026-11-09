import { describe, expect, it } from "vitest";
import { buildDemoRequest } from "../public/js/flow/demoOptions.js";
import {
  describeNoQuotes,
  selectHeadAgent,
  selectPhase,
  selectProgress,
  selectRunnersUp,
  selectStatusCounts,
  selectStayPills,
  selectTestSteps,
  selectTileSize,
  selectTopThree,
} from "../public/js/runpage/model.js";
import { createInitialState, runReducer } from "../public/js/state.js";
import type { RunState } from "../public/js/state.js";
import type { AgentEvent } from "../src/core/events";
import type { CallStatus, Decision, Job, Quote } from "../src/core/types";
import { stayToJob } from "../src/stay";

const RUN_ID = "run-page";

const wizardJob: Job = stayToJob({
  area: "downtown Toronto",
  checkIn: "2026-11-20",
  checkOut: "2026-11-23",
  guests: 2,
  bed: "king",
});

const HOTELS = [
  { id: "corner", name: "Corner Hotel" },
  { id: "harbour", name: "Harbour Inn" },
  { id: "maple", name: "Maple Suites" },
  { id: "union", name: "Union Rooms" },
];

function started(businesses: { id: string; name: string }[], provider: string = "fake"): AgentEvent {
  return { type: "run_started", runId: RUN_ID, at: 0, job: wizardJob, industryLabel: "Hotel rooms", provider, businesses };
}

function status(businessId: string, callStatus: CallStatus, at: number): AgentEvent {
  return { type: "call_status", runId: RUN_ID, at, callId: `call-${businessId}`, businessId, status: callStatus };
}

function quote(businessId: string, total: number, at: number): AgentEvent {
  const callId = `call-${businessId}`;
  return { type: "quote", runId: RUN_ID, at, callId, businessId, quote: { callId, businessId, total, fields: { total }, receivedAt: at } };
}

function quoteOf(businessId: string, total: number, at: number): Quote {
  return { callId: `call-${businessId}`, businessId, total, fields: { total }, receivedAt: at };
}

function decided(businessId: string, total: number, at: number, others: Quote[] = []): AgentEvent {
  const winner = quoteOf(businessId, total, at);
  const decision: Decision = { kind: "commit", winner, others, reason: "all-settled" };
  return { type: "decision", runId: RUN_ID, at, decision };
}

function finished(decision: Decision, at: number): AgentEvent {
  return {
    type: "run_finished",
    runId: RUN_ID,
    at,
    report: { runId: RUN_ID, job: wizardJob, provider: "fake", startedAt: 0, endedAt: at, decision, calls: [] },
  };
}

const NO_QUOTES: Decision = { kind: "none", reason: "no-quotes" };

function reduceAll(events: AgentEvent[]): RunState {
  let state = createInitialState();

  for (const event of events) {
    state = runReducer(state, event);
  }

  return state;
}

// Four hotels: Corner talks, Harbour rings, Maple quotes 500, then Union undercuts it at 420.
const liveEvents: AgentEvent[] = [
  started(HOTELS),
  status("corner", "talking", 1_000),
  status("harbour", "connecting", 1_000),
  status("maple", "talking", 1_000),
  status("union", "talking", 1_000),
  quote("maple", 500, 5_000),
  status("maple", "ended", 6_000),
  quote("union", 420, 8_000),
  status("union", "ended", 9_000),
];

function countsOf(state: RunState): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const entry of selectStatusCounts(state)) {
    counts[entry.label] = entry.count;
  }

  return counts;
}

describe("run page counts and progress", () => {
  it("shows all seven live counts, with zeros for the ones nobody is in", () => {
    const state = reduceAll(liveEvents);

    expect(countsOf(state)).toEqual({
      Talking: 1,
      "On hold": 0,
      "Phone menu": 0,
      Ringing: 1,
      Quoted: 2,
      "No answer": 0,
      "No quote": 0,
    });
    expect(selectProgress(state)).toEqual({ finished: 2, total: 4, pct: 50 });
  });

  it("shows only Quoted, No answer and No quote once the run is done", () => {
    const state = reduceAll([
      ...liveEvents,
      status("corner", "ended", 10_000),
      status("harbour", "failed", 10_000),
      decided("union", 420, 11_000),
      finished(NO_QUOTES, 11_001),
    ]);

    expect(Object.keys(countsOf(state))).toEqual(["Quoted", "No answer", "No quote"]);
    expect(countsOf(state).Quoted).toBe(2);
    expect(selectProgress(state)).toEqual({ finished: 4, total: 4, pct: 100 });
  });
});

describe("run page head agent", () => {
  function headAfter(eventCount: number) {
    return selectHeadAgent(reduceAll(liveEvents.slice(0, eventCount)), 10_000);
  }

  it("waits until the first quote", () => {
    const head = headAfter(5);

    expect(head.badge).toBe("waiting");
    expect(head.headline).toBe("Waiting for the first quote");
    expect(head.sub).toBe("4 calls in progress");
    expect(head.quoted).toBe("0 of 4 quoted");
  });

  it("calls the first quote a new leader", () => {
    const head = headAfter(6);

    expect(head.badge).toBe("ranking");
    expect(head.headline).toBe("New leader: Maple Suites $500");
    expect(head.sub).toBe("The first quote is in.");
  });

  it("names the savings when a cheaper quote takes the lead", () => {
    const head = headAfter(8);

    expect(head.headline).toBe("New leader: Union Rooms $420");
    expect(head.sub).toBe("$80 less than Maple Suites");
    expect(head.quoted).toBe("2 of 4 quoted");
  });

  it("ranks a pricier quote with the gap to the leader", () => {
    const head = selectHeadAgent(reduceAll([...liveEvents, quote("corner", 450, 9_500)]), 10_000);

    expect(head.headline).toBe("Corner Hotel quoted $450 · ranked 2nd");
    expect(head.sub).toBe("$30 above the leader, Union Rooms");
  });

  it("says it is deciding once every call has finished", () => {
    const state = reduceAll([...liveEvents, status("corner", "ended", 10_000), status("harbour", "failed", 10_000)]);

    expect(selectHeadAgent(state, 10_000).headline).toBe("All calls finished, deciding");
  });

  it("counts down to the decision once one is scheduled", () => {
    const scheduled: AgentEvent = { type: "decision_scheduled", runId: RUN_ID, at: 8_000, deadlineAt: 70_000, reason: "window" };
    const state = reduceAll([...liveEvents, scheduled]);

    expect(headAfter(8).decides).toBe("Decides after the first quote");
    expect(selectHeadAgent(state, 10_000).decides).toBe("1:00 until it decides");
  });
});

describe("run page quotes", () => {
  const quotedEvents = [...liveEvents, quote("corner", 450, 9_500), quote("harbour", 610, 9_600)];

  it("keeps the three cheapest in order", () => {
    const top = selectTopThree(reduceAll(quotedEvents));

    expect(top.map((entry) => [entry.rank, entry.name, entry.total])).toEqual([
      [1, "Union Rooms", 420],
      [2, "Corner Hotel", 450],
      [3, "Maple Suites", 500],
    ]);
  });

  it("puts #2 and #3 under the winner when done", () => {
    const state = reduceAll([
      ...quotedEvents,
      decided("union", 420, 12_000, [quoteOf("corner", 450, 9_500), quoteOf("maple", 500, 5_000), quoteOf("harbour", 610, 9_600)]),
      finished(NO_QUOTES, 12_001),
    ]);

    expect(selectPhase(state)).toBe("done");
    expect(selectRunnersUp(state).map((entry) => entry.name)).toEqual(["Corner Hotel", "Maple Suites"]);
  });

  it("has no runners-up with a single quote", () => {
    const state = reduceAll([started(HOTELS.slice(0, 1)), quote("corner", 400, 5_000)]);

    expect(selectRunnersUp(state)).toEqual([]);
  });
});

describe("run page tile size", () => {
  it("names tiles up to 12 calls, then goes medium up to 60 and small past that", () => {
    expect([12, 13, 60, 61].map((count) => selectTileSize(count))).toEqual(["named", "medium", "medium", "small"]);
  });
});

describe("run page with no quotes", () => {
  it("says nobody picked up when every call went unanswered", () => {
    const state = reduceAll([
      started(HOTELS.slice(0, 2)),
      status("corner", "failed", 5_000),
      status("harbour", "failed", 5_000),
      finished(NO_QUOTES, 6_000),
    ]);

    expect(describeNoQuotes(state)).toBe("None of the hotels picked up.");
    expect(selectTopThree(state)).toEqual([]);
  });

  it("says how many answered without a price", () => {
    const state = reduceAll([
      started(HOTELS.slice(0, 3)),
      status("corner", "failed", 5_000),
      status("harbour", "ended", 5_000),
      status("maple", "ended", 5_000),
      finished(NO_QUOTES, 6_000),
    ]);

    expect(describeNoQuotes(state)).toBe("2 hotels answered, but none gave a price.");
    expect(countsOf(state)).toEqual({ Quoted: 0, "No answer": 1, "No quote": 2 });
  });
});

describe("run page pills", () => {
  it("shows the stay and, while live, what the agent asks", () => {
    const pills = selectStayPills(reduceAll([started(HOTELS)]));

    expect(pills.map((pill) => pill.kind)).toEqual(["area", "dates", "guests", "bed", "asks"]);
    expect(pills.map((pill) => pill.text)).toContain("downtown Toronto");
  });

  it("drops the asks pill once the run is done", () => {
    const pills = selectStayPills(reduceAll([started(HOTELS), finished(NO_QUOTES, 1_000)]));

    expect(pills.map((pill) => pill.kind)).not.toContain("asks");
  });
});

describe("run page test call", () => {
  const testEvents: AgentEvent[] = [
    started([{ id: "test-call", name: "Test call" }], "live"),
    status("test-call", "connecting", 1_000),
    status("test-call", "talking", 4_000),
    quote("test-call", 389, 20_000),
    decided("test-call", 389, 22_000),
    finished(NO_QUOTES, 22_001),
  ];

  it("is its own phase with no asks pill", () => {
    const state = reduceAll(testEvents.slice(0, 2));

    expect(selectPhase(state)).toBe("test");
    expect(selectStayPills(state).map((pill) => pill.kind)).not.toContain("asks");
  });

  it("waits for your quote, then shows it", () => {
    expect(selectHeadAgent(reduceAll(testEvents.slice(0, 3)), 5_000).headline).toBe("Waiting for your quote");
    expect(selectHeadAgent(reduceAll(testEvents.slice(0, 4)), 21_000).headline).toBe("Your quote: $389");
  });

  it("walks the four steps from the run events", () => {
    const phasesAfter = [2, 3, 4, 6].map((count) => selectTestSteps(reduceAll(testEvents.slice(0, count))).map((step) => step.phase));

    expect(phasesAfter).toEqual([
      ["active", "todo", "todo", "todo"],
      ["done", "active", "todo", "todo"],
      ["done", "done", "active", "todo"],
      ["done", "done", "done", "done"],
    ]);
  });

  it("names a no-price test call", () => {
    const state = reduceAll([started([{ id: "test-call", name: "Test call" }], "live"), status("test-call", "ended", 5_000), finished(NO_QUOTES, 5_001)]);

    expect(describeNoQuotes(state)).toBe("The test call ended without a price.");
  });
});

describe("demo page requests", () => {
  it("sends a simulated run as the fake provider at the picked size", () => {
    expect(buildDemoRequest("hotels", "simulated", 200)).toEqual({ jobId: "hotels", provider: "fake", scale: 200 });
    expect(buildDemoRequest("hotels", "demo", 200)).toEqual({ jobId: "hotels", provider: "fake" });
    expect(buildDemoRequest("hotels", "chats", 6)).toEqual({ jobId: "hotels", provider: "text" });
  });
});
