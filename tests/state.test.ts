import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { onEvent } from "../src/core/events";
import type { AgentEvent } from "../src/core/events";
import { getRunLogPath, startRecorder } from "../src/core/recorder";
import { runJob } from "../src/core/run";
import { hotels } from "../src/industries/hotels";
import { loadJob } from "../src/jobs";
import { fakeProvider } from "../src/providers/fake";
import { scaleRun } from "../src/scale";
import {
  createInitialState,
  runReducer,
  selectCalls,
  selectGettingThrough,
  selectGridCounts,
  selectGridState,
  selectHeadAgentPlan,
  selectLeader,
  selectOutcomeLabel,
  selectRanking,
  selectRunStatus,
  selectStats,
  selectTopFour,
} from "../public/js/state.js";
import type { RunState } from "../public/js/state.js";

const RUN_ID = "run-test";
const WINNER_CALL_ID = "call-queen-west-suites";

let recordedEvents: AgentEvent[] = [];
let recordingDirectory = "";

// The reducer is fed the same JSONL file the recorder writes for a real fake run.
async function recordFakeRun(directory: string): Promise<AgentEvent[]> {
  const stopRecorder = startRecorder(directory);
  let runId = "";

  try {
    const report = await runJob(
      loadJob("data/jobs/hotels.json"),
      hotels,
      fakeProvider({ stepMs: 1 }),
      {
        maxParallelCalls: 3,
        decisionWindowMs: 2_000,
        runTimeoutMs: 5_000,
        settleGraceMs: 50,
        priceFlagPct: 10,
      },
    );
    runId = report.runId;
  } finally {
    stopRecorder();
  }

  const text = readFileSync(getRunLogPath(directory, runId), "utf8");
  const lines = text.trim().split("\n");
  return lines.map((line) => JSON.parse(line) as AgentEvent);
}

function reduceAll(events: AgentEvent[]): RunState {
  let state = createInitialState();

  for (const event of events) {
    state = runReducer(state, event);
  }

  return state;
}

function eventsBefore(type: AgentEvent["type"]): AgentEvent[] {
  const index = recordedEvents.findIndex((event) => event.type === type);
  return recordedEvents.slice(0, index);
}

function eventsThrough(type: AgentEvent["type"]): AgentEvent[] {
  const index = recordedEvents.findIndex((event) => event.type === type);
  return recordedEvents.slice(0, index + 1);
}

// Everything up to and including the winner hearing the commit.
function eventsThroughCommit(): AgentEvent[] {
  const index = recordedEvents.findIndex(
    (event) => event.type === "decision_pushed" && event.command === "commit",
  );
  return recordedEvents.slice(0, index + 1);
}

function findCall(state: RunState, callId: string) {
  const call = state.calls[callId];

  if (call === undefined) {
    throw new Error(`No call ${callId} in state.`);
  }

  return call;
}

function startedEvent(businessIds: string[]): AgentEvent {
  const businesses = businessIds.map((id) => {
    return { id, name: id };
  });
  const job = loadJob("data/jobs/hotels.json");

  return {
    type: "run_started",
    runId: RUN_ID,
    at: 0,
    job,
    industryLabel: "Hotel rooms",
    provider: "fake",
    businesses,
  };
}

function statusEvent(
  businessId: string,
  status: Extract<AgentEvent, { type: "call_status" }>["status"],
  at: number,
): AgentEvent {
  return {
    type: "call_status",
    runId: RUN_ID,
    at,
    callId: `call-${businessId}`,
    businessId,
    status,
  };
}

// Tacks a status onto the recorded run, so it must carry that run's id.
function winnerStatusEvent(status: "ended" | "failed"): AgentEvent {
  const started = recordedEvents[0];

  if (started === undefined || started.runId === undefined) {
    throw new Error("Nothing was recorded.");
  }

  return {
    type: "call_status",
    runId: started.runId,
    at: Date.now(),
    callId: WINNER_CALL_ID,
    businessId: "queen-west-suites",
    status,
  };
}

function quoteEvent(businessId: string, total: number, at: number): AgentEvent {
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

beforeAll(async () => {
  recordingDirectory = mkdtempSync(join(tmpdir(), "quotedesk-state-"));
  recordedEvents = await recordFakeRun(recordingDirectory);
});

afterAll(() => {
  rmSync(recordingDirectory, { recursive: true, force: true });
});

describe("runReducer on a recorded fake run", () => {
  it("ends with the run done and Queen West quoted at 398", () => {
    const state = reduceAll(recordedEvents);

    expect(selectRunStatus(state)).toBe("done");
    expect(state.deadline).toBeNull();
    expect(state.priceCheck).toMatchObject({ flaggedCount: 1 });
    expect(selectLeader(state)).toMatchObject({
      rank: 1,
      callId: WINNER_CALL_ID,
      name: "Queen West Suites",
      total: 398,
      firstTotal: 455,
      gapToLeader: 0,
    });
    expect(selectOutcomeLabel(state)).toEqual({
      text: "Quoted",
      tone: "success",
    });
  });

  it("ranks every quote with its gap to the leader", () => {
    const state = reduceAll(recordedEvents);

    const ranking = selectRanking(state).map((quote) => {
      return [quote.name, quote.total, quote.gapToLeader];
    });

    expect(ranking).toEqual([
      ["Queen West Suites", 398, 0],
      ["Harbour Inn", 412, 14],
      ["Union Station Hotel", 430, 32],
    ]);
    expect(selectTopFour(state)).toHaveLength(3);
  });

  it("matches the run summary's stats", () => {
    const state = reduceAll(recordedEvents);

    expect(selectStats(state)).toEqual({
      quoteCount: 3,
      best: 398,
      median: 412,
      savedVsMedian: 14,
      vsReferencePct: 14,
    });
  });

  it("shows one winner and two closed squares at the end", () => {
    const state = reduceAll(recordedEvents);

    expect(selectGridCounts(state)).toMatchObject({
      winner: 1,
      closed: 2,
      quoted: 0,
      talking: 0,
      "never-quoted": 0,
      "no-answer": 0,
    });
  });

  it("marks the lower price under the turn that gave it", () => {
    const state = reduceAll(recordedEvents);
    const winner = findCall(state, WINNER_CALL_ID);
    const marks = winner.turns.flatMap((turn) => turn.marks);

    expect(marks).toEqual([
      { kind: "price", total: 455, lower: false },
      { kind: "price", total: 398, lower: true },
    ]);
    expect(winner.quote).toMatchObject({ total: 398 });
    expect(winner.firstQuote).toMatchObject({ total: 455 });
  });

  it("keeps every transcript line in order", () => {
    const state = reduceAll(recordedEvents);
    const lineCount = recordedEvents.filter(
      (event) => event.type === "transcript",
    ).length;

    const turnCount = selectCalls(state).reduce(
      (sum, call) => sum + call.turns.length,
      0,
    );

    expect(turnCount).toBe(lineCount);
  });

  it("never changes a state it was given", () => {
    const half = Math.floor(recordedEvents.length / 2);
    const midState = reduceAll(recordedEvents.slice(0, half));
    const snapshot = JSON.stringify(midState);
    let state = midState;

    for (const event of recordedEvents.slice(half)) {
      state = runReducer(state, event);
    }

    expect(JSON.stringify(midState)).toBe(snapshot);
  });
});

describe("run status along the way", () => {
  it("is dialing before anyone answers", () => {
    const state = reduceAll(eventsBefore("transcript"));

    expect(selectRunStatus(state)).toBe("calling");
    expect(selectHeadAgentPlan(state).doingNow.title).toBe("Dialing businesses");
  });

  it("is asking for prices once every line is talking", () => {
    const state = reduceAll(eventsBefore("quote"));

    expect(selectRunStatus(state)).toBe("calling");
    expect(selectHeadAgentPlan(state).doingNow).toEqual({
      title: "Asking for prices",
      detail: "3 calls talking",
    });
  });

  it("is deciding as soon as a quote is in, while still collecting quotes", () => {
    const state = reduceAll(eventsThrough("quote"));

    expect(state.deadline).not.toBeNull();
    expect(selectRunStatus(state)).toBe("deciding");
    expect(selectHeadAgentPlan(state).doingNow.title).toBe("Collecting quotes");
  });

  it("is deciding while the last offers settle", () => {
    const state = reduceAll(eventsBefore("decision"));

    expect(state.deadline).toMatchObject({ reason: "all-settled" });
    expect(selectRunStatus(state)).toBe("deciding");
    expect(selectHeadAgentPlan(state).next.title).toBe("Book Queen West Suites");
  });

  it("is booking once the decision lands", () => {
    const state = reduceAll(eventsThrough("decision"));

    expect(selectRunStatus(state)).toBe("booking");
    expect(state.deadline).toBeNull();
  });
});

describe("outcome label", () => {
  it("shows nothing before the commit reaches the winner", () => {
    const state = reduceAll(eventsThrough("decision"));

    expect(selectOutcomeLabel(state)).toBeNull();
  });

  it("shows Booking... once the winner hears the commit", () => {
    const state = reduceAll(eventsThroughCommit());

    expect(selectOutcomeLabel(state)).toEqual({
      text: "Booking...",
      tone: "pending",
    });
  });

  it("shows Quoted when the winner's call ends normally", () => {
    const events = [
      ...eventsThroughCommit(),
      winnerStatusEvent("ended"),
    ];

    expect(selectOutcomeLabel(reduceAll(events))).toEqual({
      text: "Quoted",
      tone: "success",
    });
  });

  it("warns when the winner's call fails after the commit", () => {
    const events = [
      ...eventsThroughCommit(),
      winnerStatusEvent("failed"),
    ];

    expect(selectOutcomeLabel(reduceAll(events))).toEqual({
      text: "Booking not confirmed",
      tone: "warning",
    });
  });

  it("warns when the commit could not be delivered", () => {
    const events = eventsThroughCommit().map((event) => {
      if (event.type === "decision_pushed" && event.command === "commit") {
        return { ...event, delivered: false };
      }

      return event;
    });

    expect(selectOutcomeLabel(reduceAll(events))).toMatchObject({
      tone: "warning",
    });
  });

  it("warns when the run finishes without the winner's call ending", () => {
    const finished = recordedEvents.find((event) => event.type === "run_finished");

    if (finished === undefined) {
      throw new Error("The recorded run never finished.");
    }

    const events = [...eventsThroughCommit(), finished];

    expect(selectOutcomeLabel(reduceAll(events))).toEqual({
      text: "Booking not confirmed",
      tone: "warning",
    });
  });
});

describe("grid states", () => {
  const businessIds = ["queued-one", "dialing-one", "talking-one", "quoted-one", "refused-one", "missed-one"];

  function buildOpenRun(): AgentEvent[] {
    return [
      startedEvent(businessIds),
      statusEvent("queued-one", "queued", 1),
      statusEvent("dialing-one", "connecting", 2),
      statusEvent("talking-one", "talking", 3),
      statusEvent("quoted-one", "talking", 4),
      quoteEvent("quoted-one", 400, 5),
      statusEvent("refused-one", "talking", 6),
      statusEvent("refused-one", "ended", 7),
      statusEvent("missed-one", "connecting", 8),
      statusEvent("missed-one", "failed", 9),
    ];
  }

  it("follows the call status before the decision, with an answered call that ended unpriced as never quoted", () => {
    const state = reduceAll(buildOpenRun());

    const gridStates = selectCalls(state).map((call) => selectGridState(state, call));

    expect(gridStates).toEqual([
      "queued",
      "dialing",
      "talking",
      "quoted",
      "never-quoted",
      "no-answer",
    ]);
  });

  it("closes every line after the decision", () => {
    const decided: AgentEvent = {
      type: "decision",
      runId: RUN_ID,
      at: 10,
      decision: { kind: "none", reason: "no-quotes" },
    };
    const state = reduceAll([...buildOpenRun(), decided]);

    const gridStates = selectCalls(state).map((call) => selectGridState(state, call));

    expect(gridStates).toEqual([
      "never-quoted",
      "never-quoted",
      "never-quoted",
      "closed",
      "never-quoted",
      "no-answer",
    ]);
    expect(selectOutcomeLabel(state)).toBeNull();
  });

  it("keeps the lowest quote when a call repeats a higher one", () => {
    const events = [
      ...buildOpenRun(),
      quoteEvent("quoted-one", 380, 11),
      quoteEvent("quoted-one", 420, 12),
    ];
    const state = reduceAll(events);

    expect(findCall(state, "call-quoted-one").quote).toMatchObject({ total: 380 });
    expect(findCall(state, "call-quoted-one").firstQuote).toMatchObject({ total: 400 });
  });

  it("shows how long a call took to answer", () => {
    const events = [
      startedEvent(["slow-desk"]),
      statusEvent("slow-desk", "connecting", 1_000),
      statusEvent("slow-desk", "talking", 3_500),
    ];
    const state = reduceAll(events);

    expect(selectGettingThrough(findCall(state, "call-slow-desk"))).toEqual([
      { kind: "answered", afterMs: 2_500 },
    ]);
  });

  it("hides an answer time under a tenth of a second", () => {
    const events = [
      startedEvent(["instant-desk"]),
      statusEvent("instant-desk", "connecting", 1_000),
      statusEvent("instant-desk", "talking", 1_040),
    ];
    const state = reduceAll(events);

    expect(selectGettingThrough(findCall(state, "call-instant-desk"))).toEqual([]);
  });

  it("ignores events from another run", () => {
    const stray = { ...quoteEvent("talking-one", 100, 13), runId: "run-other" };
    const state = reduceAll([...buildOpenRun(), stray]);

    expect(findCall(state, "call-talking-one").quote).toBeNull();
  });
});

describe("a 120-call run", () => {
  it("reaches Deciding while calls are still open", async () => {
    const events: AgentEvent[] = [];
    const stopListening = onEvent((event) => events.push(event));
    const scaled = scaleRun(loadJob("data/jobs/hotels.json"), hotels, 120);

    try {
      await runJob(
        scaled.job,
        scaled.industry,
        fakeProvider({ stepMs: 1, failBusinessIds: scaled.noAnswerIds }),
        {
          maxParallelCalls: 120,
          decisionWindowMs: 300,
          runTimeoutMs: 5_000,
          settleGraceMs: 50,
          priceFlagPct: 10,
        },
      );
    } finally {
      stopListening();
    }

    let state = createInitialState();
    let decidingState: RunState | null = null;

    for (const event of events) {
      state = runReducer(state, event);

      if (decidingState === null && selectRunStatus(state) === "deciding") {
        decidingState = state;
      }
    }

    if (decidingState === null) {
      throw new Error("The run never reached Deciding.");
    }

    const openCalls = selectCalls(decidingState).filter((call) => call.endedAt === null);

    expect(decidingState.decision).toBeNull();
    expect(decidingState.deadline).not.toMatchObject({ reason: "all-settled" });
    expect(openCalls.length).toBeGreaterThan(0);
    expect(selectRunStatus(state)).toBe("done");
  });
});
