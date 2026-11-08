import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { HeadAgent, rankQuotes } from "../src/core/headAgent";
import type { HeadAgentOptions } from "../src/core/headAgent";
import type {
  Decision,
  DecisionDeadline,
  IndustryConfig,
  Quote,
} from "../src/core/types";

function preferFreeCancellation(a: Quote, b: Quote): number {
  const aIsFree = a.fields.freeCancellation === true;
  const bIsFree = b.fields.freeCancellation === true;

  if (aIsFree === bIsFree) {
    return 0;
  }

  if (aIsFree) {
    return -1;
  }

  return 1;
}

const testIndustry: IndustryConfig = {
  id: "test",
  label: "Test industry",
  clientNoun: "a test client",
  businessNoun: { singular: "test business", plural: "test businesses" },
  goal: "Get a test quote.",
  quoteSchema: z.object({
    total: z.number().positive(),
    freeCancellation: z.boolean().optional(),
  }),
  followUps: [],
  commitInstruction: "Confirm the test quote.",
  tieBreak: preferFreeCancellation,
  simBusinesses: [],
};

const defaultOptions: HeadAgentOptions = {
  windowMs: 10_000,
  timeoutMs: 60_000,
  graceMs: 1_000,
};

function buildQuote(
  callId: string,
  total: number,
  receivedAt: number,
  freeCancellation: boolean,
): Quote {
  return {
    callId,
    businessId: `business-${callId}`,
    total,
    fields: { total, freeCancellation },
    receivedAt,
  };
}

function buildAgent(expectedCalls: number, options: HeadAgentOptions) {
  const onDecision = vi.fn<(decision: Decision) => void>();
  const agent = new HeadAgent(testIndustry, expectedCalls, options, onDecision);
  agent.start();
  return { agent, onDecision };
}

function getCallIds(quotes: Quote[]): string[] {
  return quotes.map((quote) => quote.callId);
}

describe("rankQuotes", () => {
  it("puts the lowest total first and leaves the input unchanged", () => {
    const expensive = buildQuote("a", 200, 1, false);
    const cheap = buildQuote("b", 100, 2, false);
    const quotes = [expensive, cheap];

    const ranked = rankQuotes(quotes, testIndustry);

    expect(getCallIds(ranked)).toEqual(["b", "a"]);
    expect(getCallIds(quotes)).toEqual(["a", "b"]);
  });

  it("uses the tie-break when totals are equal", () => {
    const earlierWithoutCancellation = buildQuote("a", 100, 1, false);
    const laterWithCancellation = buildQuote("b", 100, 2, true);

    const ranked = rankQuotes(
      [earlierWithoutCancellation, laterWithCancellation],
      testIndustry,
    );

    expect(getCallIds(ranked)).toEqual(["b", "a"]);
  });

  it("uses the earliest receivedAt when the tie-break doesn't decide", () => {
    const later = buildQuote("a", 100, 2, true);
    const earlier = buildQuote("b", 100, 1, true);

    const ranked = rankQuotes([later, earlier], testIndustry);

    expect(getCallIds(ranked)).toEqual(["b", "a"]);
  });
});

describe("HeadAgent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("decides after the grace period once all calls have quoted", () => {
    const { agent, onDecision } = buildAgent(2, defaultOptions);

    agent.report("a", "business-a", { total: 200 });
    agent.report("b", "business-b", { total: 100 });

    vi.advanceTimersByTime(999);
    expect(agent.result).toBeUndefined();

    vi.advanceTimersByTime(1);
    expect(agent.result).toMatchObject({
      kind: "commit",
      reason: "all-settled",
      winner: { callId: "b", total: 100 },
      others: [{ callId: "a", total: 200 }],
    });
    expect(onDecision).toHaveBeenCalledTimes(1);
  });

  it("decides right away when graceMs is 0", () => {
    const options = { ...defaultOptions, graceMs: 0 };
    const { agent } = buildAgent(1, options);

    agent.report("a", "business-a", { total: 100 });

    expect(agent.result).toMatchObject({
      kind: "commit",
      reason: "all-settled",
    });
  });

  it("restarts the grace period on a new quote so a lower price wins", () => {
    const { agent } = buildAgent(2, defaultOptions);

    agent.report("a", "business-a", { total: 200 });
    agent.report("b", "business-b", { total: 100 });

    vi.advanceTimersByTime(999);
    agent.report("a", "business-a", { total: 90 });

    vi.advanceTimersByTime(999);
    expect(agent.result).toBeUndefined();

    vi.advanceTimersByTime(1);
    expect(agent.result).toMatchObject({
      kind: "commit",
      reason: "all-settled",
      winner: { callId: "a", total: 90 },
      others: [{ callId: "b", total: 100 }],
    });
  });

  it("keeps a call's lowest quote when a higher one is reported again", () => {
    const { agent } = buildAgent(1, defaultOptions);

    agent.report("a", "business-a", { total: 455 });
    vi.advanceTimersByTime(999);

    agent.report("a", "business-a", { total: 398 });
    vi.advanceTimersByTime(999);

    const repeated = agent.report("a", "business-a", { total: 455 });

    expect(repeated).toMatchObject({ ok: true, quote: { total: 455 } });

    vi.advanceTimersByTime(999);
    expect(agent.result).toBeUndefined();

    vi.advanceTimersByTime(1);
    expect(agent.result).toMatchObject({
      kind: "commit",
      reason: "all-settled",
      winner: { callId: "a", total: 398 },
      others: [],
    });
  });

  it("keeps the first quote when the same total is reported again", () => {
    const { agent } = buildAgent(1, defaultOptions);

    agent.report("a", "business-a", { total: 398, freeCancellation: false });
    vi.advanceTimersByTime(999);

    const repeated = agent.report("a", "business-a", {
      total: 398,
      freeCancellation: true,
    });

    expect(repeated).toMatchObject({ ok: true });

    vi.advanceTimersByTime(999);
    expect(agent.result).toBeUndefined();

    vi.advanceTimersByTime(1);
    expect(agent.result).toMatchObject({
      winner: { fields: { total: 398, freeCancellation: false } },
    });
  });

  it("announces the soonest decision deadline as timers start", () => {
    const onDeadline = vi.fn<(deadline: DecisionDeadline) => void>();
    const agent = new HeadAgent(
      testIndustry,
      2,
      defaultOptions,
      vi.fn(),
      onDeadline,
    );
    const startedAt = Date.now();

    agent.start();
    expect(onDeadline).toHaveBeenLastCalledWith({
      deadlineAt: startedAt + 60_000,
      reason: "timeout",
    });

    agent.report("a", "business-a", { total: 200 });
    expect(onDeadline).toHaveBeenLastCalledWith({
      deadlineAt: startedAt + 10_000,
      reason: "window",
    });

    agent.report("b", "business-b", { total: 100 });
    expect(onDeadline).toHaveBeenLastCalledWith({
      deadlineAt: startedAt + 1_000,
      reason: "all-settled",
    });

    vi.advanceTimersByTime(500);
    agent.report("a", "business-a", { total: 90 });
    expect(onDeadline).toHaveBeenLastCalledWith({
      deadlineAt: startedAt + 1_500,
      reason: "all-settled",
    });

    const announcementsBeforeDecision = onDeadline.mock.calls.length;
    vi.advanceTimersByTime(1_000);

    expect(agent.result).toMatchObject({ reason: "all-settled" });
    expect(onDeadline).toHaveBeenCalledTimes(announcementsBeforeDecision);
  });

  it("keeps announcing the window when it comes before the grace period", () => {
    const onDeadline = vi.fn<(deadline: DecisionDeadline) => void>();
    const options = { ...defaultOptions, graceMs: 30_000 };
    const agent = new HeadAgent(testIndustry, 1, options, vi.fn(), onDeadline);
    const startedAt = Date.now();

    agent.start();
    agent.report("a", "business-a", { total: 100 });

    expect(onDeadline).toHaveBeenLastCalledWith({
      deadlineAt: startedAt + 10_000,
      reason: "window",
    });
  });

  it("decides exactly as before when nobody listens for deadlines", () => {
    const { agent } = buildAgent(1, defaultOptions);

    agent.report("a", "business-a", { total: 100 });
    vi.advanceTimersByTime(1_000);

    expect(agent.result).toMatchObject({ reason: "all-settled" });
  });

  it("doesn't restart the grace period when a settled call hangs up", () => {
    const { agent } = buildAgent(2, defaultOptions);

    agent.report("a", "business-a", { total: 200 });
    agent.report("b", "business-b", { total: 100 });

    vi.advanceTimersByTime(999);
    agent.callEnded("a");

    vi.advanceTimersByTime(1);
    expect(agent.result).toMatchObject({ reason: "all-settled" });
  });

  it("closes the window after the first quote, not after start()", () => {
    const { agent } = buildAgent(2, defaultOptions);

    vi.advanceTimersByTime(20_000);
    expect(agent.result).toBeUndefined();

    agent.report("a", "business-a", { total: 100 });

    vi.advanceTimersByTime(9_999);
    expect(agent.result).toBeUndefined();

    vi.advanceTimersByTime(1);
    expect(agent.result).toMatchObject({
      kind: "commit",
      reason: "window",
      winner: { callId: "a" },
    });
  });

  it("doesn't restart the window on later quotes", () => {
    const { agent } = buildAgent(2, defaultOptions);

    agent.report("a", "business-a", { total: 100 });

    vi.advanceTimersByTime(9_999);
    agent.report("a", "business-a", { total: 90 });

    vi.advanceTimersByTime(1);
    expect(agent.result).toMatchObject({ reason: "window" });
  });

  it("lets the window cut a running grace period short", () => {
    const { agent } = buildAgent(2, defaultOptions);

    agent.report("a", "business-a", { total: 100 });

    vi.advanceTimersByTime(9_500);
    agent.report("b", "business-b", { total: 200 });

    vi.advanceTimersByTime(500);
    expect(agent.result).toMatchObject({ reason: "window" });
  });

  it("returns no-quotes when the hard timeout passes without quotes", () => {
    const { agent, onDecision } = buildAgent(2, defaultOptions);

    vi.advanceTimersByTime(59_999);
    expect(agent.result).toBeUndefined();

    vi.advanceTimersByTime(1);
    expect(agent.result).toEqual({ kind: "none", reason: "no-quotes" });
    expect(onDecision).toHaveBeenCalledTimes(1);
  });

  it("doesn't let a call that ended without quoting block the decision", () => {
    const { agent } = buildAgent(2, defaultOptions);

    agent.report("a", "business-a", { total: 100 });
    agent.callEnded("b");

    vi.advanceTimersByTime(1_000);
    expect(agent.result).toMatchObject({
      kind: "commit",
      reason: "all-settled",
      winner: { callId: "a" },
      others: [],
    });
  });

  it("rejects an invalid quote without recording it", () => {
    const { agent } = buildAgent(2, defaultOptions);

    const rejected = agent.report("a", "business-a", { total: -5 });

    expect(rejected).toEqual({
      ok: false,
      error: expect.stringContaining("total:"),
    });

    vi.advanceTimersByTime(10_000);
    expect(agent.result).toBeUndefined();

    agent.report("b", "business-b", { total: 100 });

    vi.advanceTimersByTime(10_000);
    expect(agent.result).toMatchObject({
      kind: "commit",
      reason: "window",
      winner: { callId: "b" },
      others: [],
    });
  });

  it("decides only once and rejects quotes after the decision", () => {
    const { agent, onDecision } = buildAgent(1, defaultOptions);

    agent.report("a", "business-a", { total: 100 });
    vi.advanceTimersByTime(1_000);

    const decision = agent.result;
    const lateReport = agent.report("a", "business-a", { total: 50 });
    agent.callEnded("a");
    vi.advanceTimersByTime(120_000);

    expect(lateReport).toEqual({
      ok: false,
      error: "A decision was already made.",
    });
    expect(agent.result).toBe(decision);
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
