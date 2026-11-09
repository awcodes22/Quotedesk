import type { AgentEvent } from "../core/events";
import type {
  Decision,
  DecisionReason,
  Job,
  PriceCheck,
  Quote,
  QuoteFields,
  RunReport,
} from "../core/types";

export type QuoteOutcome = "committed" | "closed" | "not-reached";

export type SummaryQuote = {
  rank: number;
  callId: string;
  businessId: string;
  businessName: string;
  total: number;
  firstTotal: number;
  fields: QuoteFields;
  outcome: QuoteOutcome;
};

export type MilestoneKey = "dialed" | "first-quote" | "decided" | "finished";

export type Milestone = {
  key: MilestoneKey;
  atMs: number;
};

export type RunSummary = {
  runId: string;
  job: Job;
  industryLabel: string;
  provider: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  decision: { kind: Decision["kind"]; reason: DecisionReason | "no-quotes" };
  winner: SummaryQuote | null;
  bookingConfirmed: boolean | null;
  quotes: SummaryQuote[];
  priceCheck: PriceCheck | null;
  milestones: Milestone[];
  counts: {
    calls: number;
    quoted: number;
    failed: number;
    neverQuoted: number;
  };
  stats: {
    best: number | null;
    median: number | null;
    savedVsMedian: number | null;
    vsReferencePct: number | null;
  };
};

type EventOfType<Type extends AgentEvent["type"]> = Extract<
  AgentEvent,
  { type: Type }
>;

type StartedEvent = EventOfType<"run_started">;

function isEventOfType<Type extends AgentEvent["type"]>(type: Type) {
  return function matches(event: AgentEvent): event is EventOfType<Type> {
    return event.type === type;
  };
}

function buildBusinessNames(started: StartedEvent): Map<string, string> {
  const names = new Map<string, string>();

  for (const business of started.businesses) {
    names.set(business.id, business.name);
  }

  return names;
}

function findFirstTotals(events: AgentEvent[]): Map<string, number> {
  const firstTotals = new Map<string, number>();

  for (const event of events.filter(isEventOfType("quote"))) {
    if (firstTotals.has(event.callId) === false) {
      firstTotals.set(event.callId, event.quote.total);
    }
  }

  return firstTotals;
}

function findOutcomes(events: AgentEvent[]): Map<string, QuoteOutcome> {
  const outcomes = new Map<string, QuoteOutcome>();

  for (const event of events.filter(isEventOfType("decision_pushed"))) {
    if (event.delivered && event.command === "commit") {
      outcomes.set(event.callId, "committed");
    }

    if (event.delivered && event.command === "close") {
      outcomes.set(event.callId, "closed");
    }
  }

  return outcomes;
}

// The decision already ranks one quote per call, with the industry's tie-break applied.
function listRankedQuotes(decision: Decision): Quote[] {
  if (decision.kind === "none") {
    return [];
  }

  return [decision.winner, ...decision.others];
}

function lookUp<Value>(
  values: Map<string, Value>,
  key: string,
  fallback: Value,
): Value {
  let value = fallback;
  const found = values.get(key);

  if (found !== undefined) {
    value = found;
  }

  return value;
}

function buildSummaryQuotes(
  decision: Decision,
  events: AgentEvent[],
  names: Map<string, string>,
): SummaryQuote[] {
  const firstTotals = findFirstTotals(events);
  const outcomes = findOutcomes(events);
  const rankedQuotes = listRankedQuotes(decision);

  return rankedQuotes.map((quote, index) => {
    return {
      rank: index + 1,
      callId: quote.callId,
      businessId: quote.businessId,
      businessName: lookUp(names, quote.businessId, quote.businessId),
      total: quote.total,
      firstTotal: lookUp(firstTotals, quote.callId, quote.total),
      fields: quote.fields,
      outcome: lookUp<QuoteOutcome>(outcomes, quote.callId, "not-reached"),
    };
  });
}

function countCalls(
  started: StartedEvent,
  report: RunReport,
  quotes: SummaryQuote[],
): RunSummary["counts"] {
  const quotedCallIds = new Set(quotes.map((quote) => quote.callId));
  const failedCalls = report.calls.filter((call) => call.status === "failed");
  let neverQuoted = 0;

  for (const call of report.calls) {
    const quoted = quotedCallIds.has(call.callId);

    if (quoted === false && call.status !== "failed") {
      neverQuoted += 1;
    }
  }

  return {
    calls: started.businesses.length,
    quoted: quotes.length,
    failed: failedCalls.length,
    neverQuoted,
  };
}

function buildMilestones(
  events: AgentEvent[],
  startedAt: number,
): Milestone[] {
  const markers: [MilestoneKey, AgentEvent | undefined][] = [
    ["dialed", events.find(isEventOfType("run_started"))],
    ["first-quote", events.find(isEventOfType("quote"))],
    ["decided", events.find(isEventOfType("decision"))],
    ["finished", events.find(isEventOfType("run_finished"))],
  ];
  const milestones: Milestone[] = [];

  for (const [key, event] of markers) {
    if (event !== undefined) {
      milestones.push({ key, atMs: event.at - startedAt });
    }
  }

  return milestones;
}

function findMedian(values: number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  const lower = sorted[middle - 1];

  if (upper === undefined) {
    return null;
  }

  if (sorted.length % 2 === 0 && lower !== undefined) {
    return (lower + upper) / 2;
  }

  return upper;
}

function roundToOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

function compareToReference(job: Job, best: number): number | null {
  if (job.reference === undefined || job.reference.total === undefined) {
    return null;
  }

  const reference = job.reference.total;
  return roundToOneDecimal(((best - reference) / reference) * 100);
}

function buildStats(job: Job, quotes: SummaryQuote[]): RunSummary["stats"] {
  const winner = quotes[0];
  const median = findMedian(quotes.map((quote) => quote.total));

  if (winner === undefined || median === null) {
    return {
      best: null,
      median: null,
      savedVsMedian: null,
      vsReferencePct: null,
    };
  }

  return {
    best: winner.total,
    median,
    savedVsMedian: median - winner.total,
    vsReferencePct: compareToReference(job, winner.total),
  };
}

// Booked only when the winner's call finished normally after hearing the commit.
// Live calls never book, so they have no booking to confirm.
function isBookingConfirmed(report: RunReport): boolean | null {
  const { decision } = report;

  if (decision.kind === "none" || report.provider === "live") {
    return null;
  }

  const winnerCall = report.calls.find(
    (call) => call.callId === decision.winner.callId,
  );

  if (winnerCall === undefined) {
    return false;
  }

  return winnerCall.status === "completed" && winnerCall.command === "commit";
}

function nullWhenMissing<Value>(value: Value | undefined): Value | null {
  if (value === undefined) {
    return null;
  }

  return value;
}

// Returns undefined until the run has finished, since the result isn't known before then.
export function summarizeRun(events: AgentEvent[]): RunSummary | undefined {
  const started = events.find(isEventOfType("run_started"));
  const finished = events.find(isEventOfType("run_finished"));

  if (started === undefined || finished === undefined) {
    return undefined;
  }

  const { report } = finished;
  const names = buildBusinessNames(started);
  const quotes = buildSummaryQuotes(report.decision, events, names);

  return {
    runId: report.runId,
    job: report.job,
    industryLabel: started.industryLabel,
    provider: report.provider,
    startedAt: report.startedAt,
    endedAt: report.endedAt,
    durationMs: report.endedAt - report.startedAt,
    decision: { kind: report.decision.kind, reason: report.decision.reason },
    winner: nullWhenMissing(quotes[0]),
    bookingConfirmed: isBookingConfirmed(report),
    quotes,
    priceCheck: nullWhenMissing(report.priceCheck),
    milestones: buildMilestones(events, report.startedAt),
    counts: countCalls(started, report, quotes),
    stats: buildStats(report.job, quotes),
  };
}
