import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import {
  businessSpeakerName,
  describeEmptyPrice,
  describeMissingField,
  selectCallPanelModel,
} from "../public/js/render/callPanel.js";
import { selectCompletedBarModel } from "../public/js/render/completedBar.js";
import { selectGridModel } from "../public/js/render/grid.js";
import { buildRequestFields } from "../public/js/render/header.js";
import { countFinishedLines, selectHeadAgentModel } from "../public/js/render/headAgent.js";
import { selectTopCardsModel } from "../public/js/render/topCards.js";
import type { View } from "../public/js/render/view.js";
import {
  createInitialState,
  isSelfTestRun,
  runReducer,
  selectCalls,
  selectGridState,
} from "../public/js/state.js";
import type { CallState, RunState } from "../public/js/state.js";
import { RunRegistry } from "../src/api/registry";
import { createApp } from "../src/app";
import type { AgentEvent } from "../src/core/events";
import { fakeProvider } from "../src/providers/fake";
import type { CallStatus, Decision, Job, TranscriptLine } from "../src/core/types";
import { hotels } from "../src/industries/hotels";
import { loadJob } from "../src/jobs";
import { createQuoteExtractor, NOTE_TOPICS } from "../src/providers/quoteExtractor";
import type { JsonCompletion } from "../src/providers/quoteExtractor";

const RUN_ID = "run-completed";
const GUEST_NAME = "Pat Example";
const MASKED = "+1 ••• ••• ••23";

// What a real test call sounds like once the voice tags are stripped.
const sampleTranscript: Omit<TranscriptLine, "at">[] = [
  { speaker: "business", text: "Hi, front desk, how can I help?" },
  { speaker: "agent", text: "Hi, I'm looking for a king room for November 20 to 22. What's the total?" },
  { speaker: "business", text: "I'd have to check with my manager on the rate and call you back." },
  { speaker: "agent", text: "No problem. Is breakfast included, and can it be cancelled?" },
  { speaker: "business", text: "Breakfast is included. You can cancel free up to 48 hours before." },
  { speaker: "agent", text: "Thanks, goodbye." },
];

function liveJob(): Job {
  return { ...loadJob("data/jobs/hotels.json"), guestName: GUEST_NAME };
}

function started(
  businesses: { id: string; name: string; maskedPhone?: string }[],
  provider: string = "live",
): AgentEvent {
  return {
    type: "run_started",
    runId: RUN_ID,
    at: 0,
    job: liveJob(),
    industryLabel: "Hotel rooms",
    provider,
    businesses,
  };
}

function status(businessId: string, callStatus: CallStatus, at: number): AgentEvent {
  return { type: "call_status", runId: RUN_ID, at, callId: `call-${businessId}`, businessId, status: callStatus };
}

function transcript(businessId: string, line: Omit<TranscriptLine, "at">, at: number): AgentEvent {
  return { type: "transcript", runId: RUN_ID, at, callId: `call-${businessId}`, businessId, line: { ...line, at } };
}

function note(businessId: string, text: string, at: number): AgentEvent {
  return { type: "note", runId: RUN_ID, at, callId: `call-${businessId}`, businessId, text };
}

function quote(businessId: string, total: number, at: number): AgentEvent {
  const callId = `call-${businessId}`;
  return {
    type: "quote",
    runId: RUN_ID,
    at,
    callId,
    businessId,
    quote: { callId, businessId, total, fields: { total }, receivedAt: at },
  };
}

function finished(decision: Decision, at: number): AgentEvent[] {
  return [
    { type: "decision", runId: RUN_ID, at, decision },
    {
      type: "run_finished",
      runId: RUN_ID,
      at: at + 1,
      report: { runId: RUN_ID, job: liveJob(), provider: "live", startedAt: 0, endedAt: at + 1, decision, calls: [] },
    },
  ];
}

const noQuotes: Decision = { kind: "none", reason: "no-quotes" };

// The test call from the bug report: answered, talked, hung up without a price.
function testCallWithoutPrice(): AgentEvent[] {
  const lines = sampleTranscript.map((line, index) => transcript("test-call", line, 3_000 + index * 1_000));

  return [
    started([{ id: "test-call", name: "Test call", maskedPhone: MASKED }]),
    status("test-call", "queued", 1),
    status("test-call", "connecting", 1_000),
    status("test-call", "talking", 2_000),
    ...lines,
    note("test-call", "Breakfast is included.", 9_500),
    note("test-call", "Free cancellation up to 48 hours before.", 9_501),
    status("test-call", "ended", 10_000),
    ...finished(noQuotes, 10_500),
  ];
}

function reduceAll(events: AgentEvent[]): RunState {
  let state = createInitialState();

  for (const event of events) {
    state = runReducer(state, event);
  }

  return state;
}

function buildView(state: RunState): View {
  return {
    state,
    now: 20_000,
    listing: null,
    selectedCallId: null,
    filter: "all",
    search: "",
    sort: "price",
    ended: state.finishedAt !== null,
  };
}

function onlyCall(state: RunState): CallState {
  const call = selectCalls(state)[0];

  if (call === undefined) {
    throw new Error("Expected one call.");
  }

  return call;
}

describe("head agent counts", () => {
  it("counts an answered call that ended without a price as closed politely, not no answer", () => {
    const counts = countFinishedLines(buildView(reduceAll(testCallWithoutPrice())));

    expect(counts).toEqual([
      { count: 0, text: "quotes", alert: false },
      { count: 1, text: "closed politely", alert: false },
      { count: 0, text: "no answer", alert: false },
    ]);
  });

  it("only raises the no-answer alert when a call was never picked up", () => {
    const events = [
      started([{ id: "missed", name: "Missed Hotel" }]),
      status("missed", "connecting", 1_000),
      status("missed", "failed", 5_000),
      ...finished(noQuotes, 6_000),
    ];

    const counts = countFinishedLines(buildView(reduceAll(events)));

    expect(counts[2]).toEqual({ count: 1, text: "no answer", alert: true });
  });
});

describe("grid square for a call that ended without a price", () => {
  it("is never quoted, not no answer, both before and after the decision", () => {
    const events = testCallWithoutPrice();
    const beforeDecision = reduceAll(events.slice(0, -2));
    const afterDecision = reduceAll(events);

    expect(selectGridState(beforeDecision, onlyCall(beforeDecision))).toBe("never-quoted");
    expect(selectGridState(afterDecision, onlyCall(afterDecision))).toBe("never-quoted");
  });

  it("treats a call that failed after it was answered as a conversation, not a missed call", () => {
    const events = [
      started([{ id: "dropped", name: "Dropped Hotel" }]),
      status("dropped", "connecting", 1_000),
      status("dropped", "talking", 2_000),
      status("dropped", "failed", 8_000),
    ];
    const state = reduceAll(events);

    expect(selectGridState(state, onlyCall(state))).toBe("never-quoted");
  });

  it("keeps no answer for a call that was never picked up", () => {
    const events = [
      started([{ id: "missed", name: "Missed Hotel" }]),
      status("missed", "connecting", 1_000),
      status("missed", "failed", 5_000),
    ];
    const state = reduceAll(events);

    expect(selectGridState(state, onlyCall(state))).toBe("no-answer");
  });
});

describe("no booked wording", () => {
  it("says only that no quotes came in", () => {
    const model = selectCompletedBarModel(buildView(reduceAll(testCallWithoutPrice())));

    expect(model.sentence).toEqual([{ text: "No quotes came in.", bold: false }]);
  });

  it("never says booked on the completed screen of a live run with a quote", () => {
    const events = [
      started([{ id: "corner", name: "Corner Hotel" }]),
      status("corner", "connecting", 1_000),
      status("corner", "talking", 2_000),
      quote("corner", 400, 5_000),
      status("corner", "ended", 6_000),
    ];
    const state = reduceAll(events);
    const call = onlyCall(state);
    const winner = { callId: call.callId, businessId: call.businessId, total: 400, fields: { total: 400 }, receivedAt: 5_000 };
    const decided = reduceAll([...events, ...finished({ kind: "commit", winner, others: [], reason: "all-settled" }, 7_000)]);
    const view = buildView(decided);

    const screenText = JSON.stringify([
      selectCompletedBarModel(view),
      selectHeadAgentModel(view),
      selectTopCardsModel(view),
      selectCallPanelModel(view, onlyCall(decided)),
    ]);

    expect(screenText.toLowerCase()).not.toContain("booked");
  });
});

describe("final quote fields", () => {
  it("says Not asked yet while the call is on", () => {
    const state = reduceAll(testCallWithoutPrice().slice(0, 5));

    expect(describeMissingField(onlyCall(state))).toBe("Not asked yet");
  });

  it("says Not asked once a call ends without a price, never Not asked yet", () => {
    const state = reduceAll(testCallWithoutPrice());
    const panel = selectCallPanelModel(buildView(state), onlyCall(state));

    const missing = panel.quote.fields.map((field) => field.missing);

    expect(missing.length).toBeGreaterThan(0);
    expect(missing.every((text) => text === "Not asked")).toBe(true);
  });

  it("says Not mentioned for a term the business left out of its price", () => {
    const events = [
      started([{ id: "corner", name: "Corner Hotel" }]),
      status("corner", "talking", 2_000),
      quote("corner", 400, 5_000),
      status("corner", "ended", 6_000),
    ];

    expect(describeMissingField(onlyCall(reduceAll(events)))).toBe("Not mentioned");
  });
});

describe("quote notes", () => {
  it("fills each topic the transcript mentions, in a fixed order, and leaves out the rest", async () => {
    const reply = JSON.stringify({
      quote: null,
      topics: {
        breakfast: "Breakfast is included.",
        cancellation: "Free cancellation up to 48 hours before.",
        discounts: null,
        extraFees: null,
      },
      notes: ["The manager sets the rate.", "Breakfast is included."],
    });
    const complete = vi.fn<JsonCompletion>(async () => reply);

    const extraction = await createQuoteExtractor(complete)(sampleTranscript, hotels);

    expect(extraction).toEqual({
      fields: null,
      notes: ["Breakfast is included.", "Free cancellation up to 48 hours before.", "The manager sets the rate."],
    });
  });

  it("asks for every topic and tells the model never to invent one", async () => {
    const complete = vi.fn<JsonCompletion>(async () => JSON.stringify({ quote: null, notes: [] }));

    await createQuoteExtractor(complete)(sampleTranscript, hotels);

    const call = complete.mock.calls[0];
    expect(call).toBeDefined();
    const [instructions, input, schema] = call as Parameters<JsonCompletion>;
    const properties = schema.properties as Record<string, { required: string[] }>;
    const topicSchema = properties.topics;

    if (topicSchema === undefined) {
      throw new Error("The response schema has no topics.");
    }

    expect(topicSchema.required).toEqual(Object.keys(NOTE_TOPICS));
    expect(topicSchema.required).toEqual(["breakfast", "cancellation", "discounts", "extraFees"]);
    expect(instructions).toContain("Never guess or invent a topic");
    expect(input).toContain("Business: Breakfast is included.");
  });

  it("shows the notes on the card and lists them all in the panel", () => {
    const state = reduceAll(testCallWithoutPrice());
    const view = buildView(state);
    const notes = ["Breakfast is included.", "Free cancellation up to 48 hours before."];

    const cards = selectTopCardsModel(view);
    const panel = selectCallPanelModel(view, onlyCall(state));

    expect(cards.pending).toMatchObject([{ name: "Test call", notes }]);
    expect(panel.quote.notes).toEqual(notes);
    expect(panel.quote.showAllNotes).toBe(true);
  });
});

describe("test call screen", () => {
  it("shows one card per call, with no empty placeholders", () => {
    const cards = selectTopCardsModel(buildView(reduceAll(testCallWithoutPrice())));

    expect(cards.slotCount).toBe(1);
    expect(cards.cards).toEqual([]);
    expect(cards.pending).toMatchObject([{ name: "Test call", status: "Ended without a price" }]);
  });

  it("puts the guest name and Test call in the header, and labels the answering side You", () => {
    const state = reduceAll(testCallWithoutPrice());
    const job = liveJob();

    const fields = buildRequestFields(job, "Hotel rooms", 1, null, isSelfTestRun(state));

    expect(fields).toContainEqual({ icon: "phone", label: "Calling", value: "Test call" });
    expect(fields).toContainEqual({ icon: "user", label: "Guest", value: GUEST_NAME });
    expect(businessSpeakerName(buildView(state), onlyCall(state))).toBe("You");
  });

  it("labels a real hotel's side Front desk", () => {
    const events = [started([{ id: "corner", name: "Corner Hotel" }]), status("corner", "talking", 2_000)];
    const state = reduceAll(events);

    expect(businessSpeakerName(buildView(state), onlyCall(state))).toBe("Front desk");
  });
});

function businessIds(count: number): { id: string; name: string }[] {
  const businesses: { id: string; name: string }[] = [];

  for (let index = 1; index <= count; index += 1) {
    businesses.push({ id: `hotel-${index}`, name: `Hotel ${index}` });
  }

  return businesses;
}

// A Demo run where the winner heard the commit and ended its call normally.
function demoRunWithWinner(): AgentEvent[] {
  const decision: Decision = {
    kind: "commit",
    winner: { callId: "call-corner", businessId: "corner", total: 400, fields: { total: 400 }, receivedAt: 5_000 },
    others: [],
    reason: "all-settled",
  };

  return [
    started([{ id: "corner", name: "Corner Hotel" }], "fake"),
    status("corner", "connecting", 1_000),
    status("corner", "talking", 2_000),
    quote("corner", 400, 5_000),
    { type: "decision", runId: RUN_ID, at: 6_000, decision },
    {
      type: "decision_pushed",
      runId: RUN_ID,
      at: 6_001,
      callId: "call-corner",
      businessId: "corner",
      command: "commit",
      delivered: true,
    },
    status("corner", "ended", 7_000),
  ];
}

describe("small UI fixes", () => {
  it("labels the guest Guest in the header", () => {
    const fields = buildRequestFields(liveJob(), "Hotel rooms", 3, null);

    expect(fields).toContainEqual({ icon: "user", label: "Guest", value: GUEST_NAME });
    expect(JSON.stringify(fields)).not.toContain("Booking for");
  });

  it("gives every new run LIVE_GUEST_NAME, not the job's contact", async () => {
    const registry = new RunRegistry();
    const stop = registry.start();
    const app = createApp({
      jobsDirectory: "data/jobs",
      runsDirectory: "runs-unused",
      publicDirectory: "public",
      runOptions: { maxParallelCalls: 3, decisionWindowMs: 2_000, runTimeoutMs: 5_000, settleGraceMs: 10, priceFlagPct: 10 },
      maxTurns: 14,
      createProvider: () => fakeProvider({ stepMs: 1 }),
      registry,
      liveLimits: { allowedNumbers: [], maxCalls: 6, callTimeoutMs: 10_000, guestName: GUEST_NAME },
    });

    const response = await request(app).post("/api/runs").send({ jobId: "toronto-weekend", provider: "fake" });
    const events = registry.getEvents(response.body.runId);
    stop();

    expect(response.status).toBe(201);
    expect(events).toBeDefined();
    const runStarted = (events as AgentEvent[]).find((event) => event.type === "run_started");
    expect(runStarted).toMatchObject({ job: { guestName: GUEST_NAME } });
  });

  it("says Quoted, not Confirmed, when a Demo or Chats winner ends its call", () => {
    const state = reduceAll(demoRunWithWinner());
    const view = buildView(state);
    const sentence = selectCompletedBarModel(view).sentence.map((part) => part.text).join("");

    expect(sentence).toContain("Quoted Corner Hotel at $400");
    expect(JSON.stringify([selectCompletedBarModel(view), selectHeadAgentModel(view)])).not.toContain("Confirmed");
  });

  it("says No price given once a call has ended without one", () => {
    const state = reduceAll(testCallWithoutPrice());
    const openState = reduceAll(testCallWithoutPrice().slice(0, 5));

    expect(describeEmptyPrice(onlyCall(openState))).toBe("No price yet");
    expect(selectCallPanelModel(buildView(state), onlyCall(state)).quote.emptyPrice).toBe("No price given");
  });

  it("keeps the neutral agent icon when there is no winner, and the check when there is one", () => {
    const noWinner = selectHeadAgentModel(buildView(reduceAll(testCallWithoutPrice())));
    const withWinner = selectHeadAgentModel(buildView(reduceAll([...demoRunWithWinner(), ...finished(noQuotes, 8_000).slice(1)])));

    expect(noWinner).toMatchObject({ finished: true, hasWinner: false });
    expect(withWinner).toMatchObject({ finished: true, hasWinner: true });
  });

  it("hides the grid when the cards already show every call", () => {
    for (const count of [1, 4]) {
      const model = selectGridModel(buildView(reduceAll([started(businessIds(count))])));
      expect(model.hidden).toBe(true);
    }

    const bigRun = selectGridModel(buildView(reduceAll([started(businessIds(5))])));
    expect(bigRun.hidden).toBe(false);
  });

  it("gives a run of exactly 4 calls a card for each, quoted or not", () => {
    const cards = selectTopCardsModel(buildView(reduceAll([started(businessIds(4))])));

    expect(cards.slotCount).toBe(4);
    expect(cards.pending).toHaveLength(4);
  });
});
