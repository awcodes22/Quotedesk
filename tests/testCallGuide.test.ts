import { describe, expect, it } from "vitest";
import { buildMarks } from "../public/js/render/callPanel.js";
import { selectCompletedBarModel } from "../public/js/render/completedBar.js";
import { selectGuideModel } from "../public/js/render/guide.js";
import { selectStatsModel } from "../public/js/render/stats.js";
import type { View } from "../public/js/render/view.js";
import { createInitialState, runReducer } from "../public/js/state.js";
import type { RunState, Turn } from "../public/js/state.js";
import type { AgentEvent } from "../src/core/events";
import type { CallStatus, Decision, TranscriptLine } from "../src/core/types";
import { hotels } from "../src/industries/hotels";
import { loadJob } from "../src/jobs";
import { FIRST_MESSAGE_INTROS } from "../src/providers/live";
import { createQuoteExtractor } from "../src/providers/quoteExtractor";

const RUN_ID = "run-guide";

function started(businesses: { id: string; name: string }[], provider: string = "live"): AgentEvent {
  return {
    type: "run_started",
    runId: RUN_ID,
    at: 0,
    job: loadJob("data/jobs/hotels.json"),
    industryLabel: "Hotel rooms",
    provider,
    businesses,
  };
}

function status(businessId: string, callStatus: CallStatus, at: number): AgentEvent {
  return { type: "call_status", runId: RUN_ID, at, callId: `call-${businessId}`, businessId, status: callStatus };
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

function decided(businessId: string, total: number, at: number): AgentEvent {
  const winner = { callId: `call-${businessId}`, businessId, total, fields: { total }, receivedAt: at };
  const decision: Decision = { kind: "commit", winner, others: [], reason: "all-settled" };
  return { type: "decision", runId: RUN_ID, at, decision };
}

function runFinished(at: number): AgentEvent {
  const decision: Decision = { kind: "none", reason: "no-quotes" };
  return {
    type: "run_finished",
    runId: RUN_ID,
    at,
    report: { runId: RUN_ID, job: loadJob("data/jobs/hotels.json"), provider: "live", startedAt: 0, endedAt: at, decision, calls: [] },
  };
}

// One test call, step by step, the way the live provider reports it.
const testCallEvents: AgentEvent[] = [
  started([{ id: "test-call", name: "Test call" }]),
  status("test-call", "queued", 1),
  status("test-call", "connecting", 1_000),
  status("test-call", "talking", 4_000),
  quote("test-call", 400, 30_000),
  decided("test-call", 400, 33_000),
  runFinished(33_001),
];

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
    now: 40_000,
    listing: null,
    selectedCallId: null,
    filter: "all",
    search: "",
    sort: "price",
    ended: state.finishedAt !== null,
  };
}

function guideAfter(eventCount: number) {
  return selectGuideModel(buildView(reduceAll(testCallEvents.slice(0, eventCount))));
}

describe("test call guide", () => {
  it("follows the run events step by step, with a check on every finished step", () => {
    const phasesAfter = [3, 4, 5, 6].map((count) => guideAfter(count).steps.map((step) => step.phase));

    expect(phasesAfter).toEqual([
      ["active", "todo", "todo", "todo"],
      ["done", "active", "todo", "todo"],
      ["done", "done", "active", "todo"],
      ["done", "done", "done", "active"],
    ]);
  });

  it("names the four steps", () => {
    expect(guideAfter(3).steps.map((step) => step.text)).toEqual([
      "QuoteDesk calls you",
      "You play the front desk",
      "Your quote lands here",
      "The head agent picks the best",
    ]);
  });

  it("outlines the cards for step 3, the head agent for step 4, and nothing for steps 1 and 2", () => {
    expect([3, 4, 5, 6].map((count) => guideAfter(count).focus)).toEqual([null, null, "cards", "head-agent"]);
  });

  it("stays after the run ends with every step checked and no outline", () => {
    const guide = guideAfter(testCallEvents.length);

    expect(guide.visible).toBe(true);
    expect(guide.steps.every((step) => step.phase === "done")).toBe(true);
    expect(guide.focus).toBeNull();
  });

  it("never shows on a normal live run or a Demo run", () => {
    const liveRun = reduceAll([started([{ id: "corner", name: "Corner Hotel" }])]);
    const demoRun = reduceAll([started([{ id: "test-call", name: "Test call" }], "fake")]);

    expect(selectGuideModel(buildView(liveRun)).visible).toBe(false);
    expect(selectGuideModel(buildView(demoRun)).visible).toBe(false);
  });
});

describe("test call intro", () => {
  it("introduces QuoteDesk and says it is a test", () => {
    expect(FIRST_MESSAGE_INTROS.test).toBe(
      "Hi, this is QuoteDesk. I'm an AI that calls hotels for you, gets quotes from several at once, and picks the best deal. This is a test call, so you'll get to see how it works.",
    );
  });
});

function frontDesk(...lines: string[]): Omit<TranscriptLine, "at">[] {
  const transcript: Omit<TranscriptLine, "at">[] = [{ speaker: "agent", text: "What's the total, and can it be cancelled?" }];

  for (const text of lines) {
    transcript.push({ speaker: "business", text });
  }

  return transcript;
}

// The model's reply is fixed here, so these tests check the correction, not the model.
function extractWith(fields: Record<string, unknown>, notes: string[] = []) {
  const reply = JSON.stringify({ quote: fields, notes });
  return createQuoteExtractor(async () => reply);
}

describe("cancellation terms", () => {
  it("reads free cancellation with a deadline as Yes, with the deadline in the notes", async () => {
    const extract = extractWith({ total: 400, freeCancellation: false });

    const extraction = await extract(
      frontDesk("It's 400 total.", "We have free cancellation up to 2 days before check-in."),
      hotels,
    );

    expect(extraction.fields).toEqual({ total: 400, freeCancellation: true });
    expect(extraction.notes).toEqual(["We have free cancellation up to 2 days before check-in."]);
  });

  it("also reads 'you can cancel free up to 48 hours before' as Yes", async () => {
    const extract = extractWith({ total: 400 }, ["Free cancellation until 48 hours before arrival."]);

    const extraction = await extract(frontDesk("400. You can cancel free up to 48 hours before."), hotels);

    expect(extraction.fields).toEqual({ total: 400, freeCancellation: true });
    expect(extraction.notes).toEqual(["Free cancellation until 48 hours before arrival."]);
  });

  it("only marks non-refundable when the business says it can't be cancelled or refunded", async () => {
    const extract = extractWith({ total: 360, freeCancellation: true });

    const extraction = await extract(
      frontDesk("That's 360. It's a non-refundable rate, so it can't be cancelled."),
      hotels,
    );

    expect(extraction.fields).toEqual({ total: 360, freeCancellation: false });
  });

  it("drops a non-refundable guess when cancellation never came up", async () => {
    const extract = extractWith({ total: 400, freeCancellation: false });

    const extraction = await extract(frontDesk("It's 400 with taxes."), hotels);

    expect(extraction.fields).toEqual({ total: 400 });
  });
});

describe("price comparisons", () => {
  function statLabels(events: AgentEvent[]): string[] {
    return selectStatsModel(buildView(reduceAll(events))).stats.map((stat) => stat.label);
  }

  it("are hidden on a test call", () => {
    const view = buildView(reduceAll(testCallEvents));

    expect(statLabels(testCallEvents)).toEqual(["Best so far", "Median quote"]);
    expect(selectCompletedBarModel(view).stats).toEqual([]);
  });

  it("are hidden on a run with one quote and shown once there are two", () => {
    const businesses = [
      { id: "corner", name: "Corner Hotel" },
      { id: "harbour", name: "Harbour Inn" },
    ];
    const oneQuote = [started(businesses), quote("corner", 400, 5_000)];
    const twoQuotes = [...oneQuote, quote("harbour", 450, 6_000)];

    const comparesOnline = (labels: string[]) => labels.some((label) => label.includes("online"));

    expect(statLabels(oneQuote)).not.toContain("Saved vs median");
    expect(comparesOnline(statLabels(oneQuote))).toBe(false);
    expect(statLabels(twoQuotes)).toContain("Saved vs median");
    expect(comparesOnline(statLabels(twoQuotes))).toBe(true);
  });
});

describe("transcript tool lines", () => {
  function turnWith(marks: Turn["marks"]): Turn {
    return { speaker: "business", text: "Breakfast is included.", at: 1, marks };
  }

  it("collapses notes saved together into one line", () => {
    const note = { kind: "note" as const, text: "x" };

    expect(buildMarks(turnWith([note, note, note, note]))).toEqual([{ kind: "note", text: "4 notes saved" }]);
    expect(buildMarks(turnWith([note]))).toEqual([{ kind: "note", text: "Note saved" }]);
  });

  it("keeps a price line and shows a repeated one once", () => {
    const price = { kind: "price" as const, total: 400, lower: false };
    const note = { kind: "note" as const, text: "x" };

    expect(buildMarks(turnWith([price, price, note, note]))).toEqual([
      { kind: "price", text: "Price recorded: $400" },
      { kind: "note", text: "2 notes saved" },
    ]);
  });
});
