// @ts-check

/**
 * @typedef {import("../../src/core/events").AgentEvent} AgentEvent
 * @typedef {import("../../src/core/types").CallStatus} CallStatus
 * @typedef {import("../../src/core/types").CallCommand} CallCommand
 * @typedef {import("../../src/core/types").Decision} Decision
 * @typedef {import("../../src/core/types").DecisionDeadline} DecisionDeadline
 * @typedef {import("../../src/core/types").Job} Job
 * @typedef {import("../../src/core/types").PriceCheck} PriceCheck
 * @typedef {import("../../src/core/types").Quote} Quote
 * @typedef {import("../../src/core/types").QuoteFields} QuoteFields
 */

/**
 * @typedef {{ kind: "price", total: number, lower: boolean } | { kind: "note", text: string }} TurnMark
 *
 * @typedef {{
 *   speaker: "agent" | "business",
 *   text: string,
 *   at: number,
 *   marks: TurnMark[],
 * }} Turn
 *
 * @typedef {{
 *   callId: string,
 *   businessId: string,
 *   name: string,
 *   maskedPhone: string | null,
 *   listing: import("../../src/core/types").PublicListing | null,
 *   brief: Record<string, string> | null,
 *   status: CallStatus,
 *   quote: Quote | null,
 *   firstQuote: Quote | null,
 *   notes: string[],
 *   turns: Turn[],
 *   queuedAt: number | null,
 *   dialedAt: number | null,
 *   answeredAt: number | null,
 *   endedAt: number | null,
 *   command: CallCommand | null,
 *   commandDelivered: boolean | null,
 * }} CallState
 *
 * @typedef {{
 *   runId: string | null,
 *   job: Job | null,
 *   industryLabel: string,
 *   provider: string,
 *   startedAt: number | null,
 *   finishedAt: number | null,
 *   callOrder: string[],
 *   calls: Record<string, CallState>,
 *   deadline: DecisionDeadline | null,
 *   decision: Decision | null,
 *   decidedAt: number | null,
 *   priceCheck: PriceCheck | null,
 *   winnerGone: boolean,
 *   lastEventAt: number | null,
 * }} RunState
 *
 * @typedef {"calling" | "quotes" | "deciding" | "booking" | "done"} RunStatus
 *
 * @typedef {"winner" | "quoted" | "talking" | "dialing" | "queued" | "no-answer"
 *   | "refused" | "closed" | "never-quoted"} GridState
 *
 * @typedef {{
 *   rank: number,
 *   callId: string,
 *   businessId: string,
 *   name: string,
 *   total: number,
 *   firstTotal: number,
 *   fields: QuoteFields,
 *   gapToLeader: number,
 * }} RankedQuote
 *
 * @typedef {{
 *   quoteCount: number,
 *   best: number | null,
 *   median: number | null,
 *   savedVsMedian: number | null,
 *   vsReferencePct: number | null,
 * }} RunStats
 *
 * @typedef {{ text: string, tone: "pending" | "success" | "warning" }} OutcomeLabel
 *
 * @typedef {{ title: string, detail: string }} PlanLine
 * @typedef {{ doingNow: PlanLine, next: PlanLine }} HeadAgentPlan
 *
 * @typedef {{ kind: "answered", afterMs: number }} GettingThroughStep
 */

// Every state a square can show, in legend order. Phone menu and on hold are left out
// until a provider reports them.
/** @type {GridState[]} */
export const GRID_STATES = [
  "winner",
  "quoted",
  "talking",
  "dialing",
  "queued",
  "no-answer",
  "refused",
  "closed",
  "never-quoted",
];

const TOP_COUNT = 4;

/** @type {CallStatus[]} */
const FINISHED_CALL_STATUSES = ["ended", "failed", "skipped"];

/** @returns {RunState} */
export function createInitialState() {
  return {
    runId: null,
    job: null,
    industryLabel: "",
    provider: "",
    startedAt: null,
    finishedAt: null,
    callOrder: [],
    calls: {},
    deadline: null,
    decision: null,
    decidedAt: null,
    priceCheck: null,
    winnerGone: false,
    lastEventAt: null,
  };
}

/**
 * run_started lists businesses, not calls, so the id is built the same way the run loop builds it.
 * @param {import("../../src/core/events").RunBusiness} business
 * @returns {CallState}
 */
function createCall(business) {
  let maskedPhone = null;
  let listing = null;

  if (business.maskedPhone !== undefined) {
    maskedPhone = business.maskedPhone;
  }

  if (business.publicListing !== undefined) {
    listing = business.publicListing;
  }

  return {
    callId: `call-${business.id}`,
    businessId: business.id,
    name: business.name,
    maskedPhone,
    listing,
    brief: null,
    status: "queued",
    quote: null,
    firstQuote: null,
    notes: [],
    turns: [],
    queuedAt: null,
    dialedAt: null,
    answeredAt: null,
    endedAt: null,
    command: null,
    commandDelivered: null,
  };
}

/**
 * Returns a new state with one call replaced, leaving the old state untouched.
 * @param {RunState} state
 * @param {string} callId
 * @param {(call: CallState) => CallState} change
 * @returns {RunState}
 */
function updateCall(state, callId, change) {
  const call = state.calls[callId];

  if (call === undefined) {
    return state;
  }

  const calls = { ...state.calls, [callId]: change(call) };
  return { ...state, calls };
}

/**
 * Notes and recorded prices show under the turn that produced them.
 * @param {Turn[]} turns
 * @param {TurnMark} mark
 * @returns {Turn[]}
 */
function markLastTurn(turns, mark) {
  const lastTurn = turns[turns.length - 1];

  if (lastTurn === undefined) {
    return turns;
  }

  const markedTurn = { ...lastTurn, marks: [...lastTurn.marks, mark] };
  return [...turns.slice(0, -1), markedTurn];
}

/**
 * @param {RunState} state
 * @param {Extract<AgentEvent, { type: "run_started" }>} event
 * @returns {RunState}
 */
function startRun(state, event) {
  /** @type {Record<string, CallState>} */
  const calls = {};
  const callOrder = [];

  for (const business of event.businesses) {
    const call = createCall(business);
    calls[call.callId] = call;
    callOrder.push(call.callId);
  }

  return {
    ...createInitialState(),
    runId: event.runId,
    job: event.job,
    industryLabel: event.industryLabel,
    provider: event.provider,
    startedAt: event.at,
    callOrder,
    calls,
  };
}

/**
 * @param {CallState} call
 * @param {CallStatus} status
 * @param {number} at
 * @returns {CallState}
 */
function applyCallStatus(call, status, at) {
  const updated = { ...call, status };

  if (status === "queued") {
    updated.queuedAt = at;
  }

  if (status === "connecting") {
    updated.dialedAt = at;
  }

  if (status === "talking") {
    updated.answeredAt = at;
  }

  if (FINISHED_CALL_STATUSES.includes(status)) {
    updated.endedAt = at;
  }

  return updated;
}

/**
 * @param {CallState} call
 * @param {Extract<AgentEvent, { type: "transcript" }>} event
 * @returns {CallState}
 */
function addTurn(call, event) {
  const turn = {
    speaker: event.line.speaker,
    text: event.line.text,
    at: event.line.at,
    marks: [],
  };

  return { ...call, turns: [...call.turns, turn] };
}

/**
 * Keeps the lowest offer, the same way the head agent ranks a call.
 * @param {CallState} call
 * @param {Quote} quote
 * @returns {CallState}
 */
function addQuote(call, quote) {
  let firstQuote = call.firstQuote;
  let currentQuote = call.quote;
  let lower = false;

  if (firstQuote === null) {
    firstQuote = quote;
  }

  if (currentQuote !== null && quote.total < currentQuote.total) {
    lower = true;
  }

  if (currentQuote === null || quote.total < currentQuote.total) {
    currentQuote = quote;
  }

  /** @type {TurnMark} */
  const mark = { kind: "price", total: quote.total, lower };
  const turns = markLastTurn(call.turns, mark);
  return { ...call, firstQuote, quote: currentQuote, turns };
}

/**
 * @param {CallState} call
 * @param {string} text
 * @returns {CallState}
 */
function addNote(call, text) {
  const turns = markLastTurn(call.turns, { kind: "note", text });
  return { ...call, notes: [...call.notes, text], turns };
}

/**
 * @param {CallState} call
 * @param {CallCommand} command
 * @param {boolean} delivered
 * @returns {CallState}
 */
function applyCommand(call, command, delivered) {
  return { ...call, command, commandDelivered: delivered };
}

/**
 * @param {RunState} state
 * @param {Extract<AgentEvent, { type: "alert" }>} event
 * @returns {RunState}
 */
function applyAlert(state, event) {
  if (event.code === "WINNER_GONE") {
    return { ...state, winnerGone: true };
  }

  return state;
}

/**
 * @param {RunState} state
 * @param {AgentEvent} event
 * @returns {RunState}
 */
function applyRunEvent(state, event) {
  switch (event.type) {
    case "run_started":
      return startRun(state, event);
    case "call_status":
      return updateCall(state, event.callId, (call) =>
        applyCallStatus(call, event.status, event.at),
      );
    case "transcript":
      return updateCall(state, event.callId, (call) => addTurn(call, event));
    case "quote":
      return updateCall(state, event.callId, (call) =>
        addQuote(call, event.quote),
      );
    case "call_brief":
      return updateCall(state, event.callId, (call) => ({ ...call, brief: event.variables }));
    case "note":
      return updateCall(state, event.callId, (call) =>
        addNote(call, event.text),
      );
    case "decision_scheduled":
      return {
        ...state,
        deadline: { deadlineAt: event.deadlineAt, reason: event.reason },
      };
    case "decision":
      return {
        ...state,
        decision: event.decision,
        decidedAt: event.at,
        deadline: null,
      };
    case "decision_pushed":
      return updateCall(state, event.callId, (call) =>
        applyCommand(call, event.command, event.delivered),
      );
    case "price_check":
      return { ...state, priceCheck: event.check };
    case "run_finished":
      return { ...state, finishedAt: event.at };
    case "alert":
      return applyAlert(state, event);
    default:
      return state;
  }
}

/**
 * Pure: the same events in the same order always give the same state.
 * @param {RunState} state
 * @param {AgentEvent} event
 * @returns {RunState}
 */
export function runReducer(state, event) {
  const isNewRun = event.type === "run_started";
  const belongsToOtherRun =
    state.runId !== null && event.runId !== undefined && event.runId !== state.runId;

  if (isNewRun === false && belongsToOtherRun) {
    return state;
  }

  const nextState = applyRunEvent(state, event);

  // The page compares this with its own clock, so timers stay right even if the clocks differ.
  return { ...nextState, lastEventAt: event.at };
}

/**
 * @param {RunState} state
 * @returns {CallState[]}
 */
export function selectCalls(state) {
  const calls = [];

  for (const callId of state.callOrder) {
    const call = state.calls[callId];

    if (call !== undefined) {
      calls.push(call);
    }
  }

  return calls;
}

/**
 * @param {Quote} a
 * @param {Quote} b
 * @returns {number}
 */
function compareQuotes(a, b) {
  if (a.total !== b.total) {
    return a.total - b.total;
  }

  return a.receivedAt - b.receivedAt;
}

/**
 * The decision's order wins once it exists, because it includes the industry's tie-break.
 * @param {RunState} state
 * @returns {Quote[]}
 */
function listRankedQuotes(state) {
  const decision = state.decision;

  if (decision !== null && decision.kind === "commit") {
    return [decision.winner, ...decision.others];
  }

  const quotes = [];

  for (const call of selectCalls(state)) {
    if (call.quote !== null) {
      quotes.push(call.quote);
    }
  }

  quotes.sort(compareQuotes);
  return quotes;
}

/**
 * @param {RunState} state
 * @returns {RankedQuote[]}
 */
export function selectRanking(state) {
  const quotes = listRankedQuotes(state);
  const leader = quotes[0];
  let leaderTotal = 0;

  if (leader !== undefined) {
    leaderTotal = leader.total;
  }

  return quotes.map((quote, index) => {
    const call = state.calls[quote.callId];
    let name = quote.businessId;
    let firstTotal = quote.total;

    if (call !== undefined) {
      name = call.name;
    }

    if (call !== undefined && call.firstQuote !== null) {
      firstTotal = call.firstQuote.total;
    }

    return {
      rank: index + 1,
      callId: quote.callId,
      businessId: quote.businessId,
      name,
      total: quote.total,
      firstTotal,
      fields: quote.fields,
      gapToLeader: quote.total - leaderTotal,
    };
  });
}

/**
 * @param {RunState} state
 * @returns {RankedQuote | null}
 */
export function selectLeader(state) {
  const leader = selectRanking(state)[0];

  if (leader === undefined) {
    return null;
  }

  return leader;
}

/**
 * @param {RunState} state
 * @returns {RankedQuote[]}
 */
export function selectTopFour(state) {
  return selectRanking(state).slice(0, TOP_COUNT);
}

/**
 * @param {RunState} state
 * @returns {RunStatus}
 */
export function selectRunStatus(state) {
  const decision = state.decision;

  if (state.finishedAt !== null) {
    return "done";
  }

  if (decision !== null && decision.kind === "commit") {
    return "booking";
  }

  const hasQuote = selectCalls(state).some((call) => call.quote !== null);

  // Once a quote is in, the head agent is counting down to a decision even while calls talk on.
  if (decision !== null || (hasQuote && state.deadline !== null)) {
    return "deciding";
  }

  if (hasQuote) {
    return "quotes";
  }

  return "calling";
}

/**
 * Live runs place real phone calls that only gather quotes and never book.
 * @param {string} provider
 * @returns {boolean}
 */
export function isLiveProvider(provider) {
  return provider === "live";
}

// The server gives the one call of a "Call me to test" run this business id.
const SELF_TEST_BUSINESS_ID = "test-call";

/**
 * @param {CallState} call
 * @returns {boolean}
 */
export function isSelfTestCall(call) {
  return call.businessId === SELF_TEST_BUSINESS_ID;
}

/**
 * A median and a market comparison need several real quotes. One quote, or a test call
 * answered by the user, would only produce meaningless savings.
 * @param {RunState} state
 * @returns {boolean}
 */
export function showsPriceComparisons(state) {
  return isSelfTestRun(state) === false && selectStats(state).quoteCount >= 2;
}

/**
 * @param {RunState} state
 * @returns {boolean}
 */
export function isSelfTestRun(state) {
  const calls = selectCalls(state);
  return isLiveProvider(state.provider) && calls.length === 1 && calls.every(isSelfTestCall);
}

/**
 * @param {RunState} state
 * @returns {string | null}
 */
function findWinnerCallId(state) {
  const decision = state.decision;

  if (decision === null || decision.kind === "none") {
    return null;
  }

  return decision.winner.callId;
}

/**
 * No answer means nobody ever picked up. A call that failed after it was answered had a conversation.
 * @param {CallState} call
 * @returns {boolean}
 */
export function isNoAnswer(call) {
  return call.status === "failed" && call.answeredAt === null;
}

/**
 * Someone picked up and talked, but the call ended without a price.
 * @param {CallState} call
 * @returns {boolean}
 */
export function endedWithoutPrice(call) {
  const lineClosed = call.status === "ended" || call.status === "failed";
  return lineClosed && call.answeredAt !== null && call.quote === null;
}

/**
 * @param {CallState} call
 * @returns {GridState}
 */
function findOpenGridState(call) {
  if (call.quote !== null) {
    return "quoted";
  }

  if (endedWithoutPrice(call)) {
    return "never-quoted";
  }

  if (call.status === "queued") {
    return "queued";
  }

  if (call.status === "connecting") {
    return "dialing";
  }

  if (call.status === "ended" || call.status === "skipped") {
    return "refused";
  }

  return "talking";
}

/**
 * @param {RunState} state
 * @param {CallState} call
 * @returns {GridState}
 */
export function selectGridState(state, call) {
  if (isNoAnswer(call)) {
    return "no-answer";
  }

  if (state.decision === null) {
    return findOpenGridState(call);
  }

  if (findWinnerCallId(state) === call.callId) {
    return "winner";
  }

  if (call.quote !== null) {
    return "closed";
  }

  return "never-quoted";
}

/**
 * @param {RunState} state
 * @returns {Record<GridState, number>}
 */
export function selectGridCounts(state) {
  /** @type {Record<GridState, number>} */
  const counts = {
    winner: 0,
    quoted: 0,
    talking: 0,
    dialing: 0,
    queued: 0,
    "no-answer": 0,
    refused: 0,
    closed: 0,
    "never-quoted": 0,
  };

  for (const call of selectCalls(state)) {
    const gridState = selectGridState(state, call);
    counts[gridState] += 1;
  }

  return counts;
}

/**
 * @param {number[]} values
 * @returns {number | null}
 */
function findMedian(values) {
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

/**
 * Rounded like the run summary, so the live numbers match the breakdown.
 * @param {Job | null} job
 * @param {number} best
 * @returns {number | null}
 */
function compareToReference(job, best) {
  if (job === null || job.reference === undefined) {
    return null;
  }

  const reference = job.reference.total;

  if (reference === undefined) {
    return null;
  }

  const pct = ((best - reference) / reference) * 100;
  return Math.round(pct * 10) / 10;
}

/**
 * @param {RunState} state
 * @returns {RunStats}
 */
export function selectStats(state) {
  const totals = selectRanking(state).map((quote) => quote.total);
  const best = totals[0];
  const median = findMedian(totals);

  if (best === undefined || median === null) {
    return {
      quoteCount: 0,
      best: null,
      median: null,
      savedVsMedian: null,
      vsReferencePct: null,
    };
  }

  return {
    quoteCount: totals.length,
    best,
    median,
    savedVsMedian: median - best,
    vsReferencePct: compareToReference(state.job, best),
  };
}

/**
 * Quoted only once the winner's call ends normally after hearing the commit.
 * @param {RunState} state
 * @returns {OutcomeLabel | null}
 */
export function selectOutcomeLabel(state) {
  const winnerCallId = findWinnerCallId(state);

  if (winnerCallId === null) {
    return null;
  }

  // Live calls never book, so the head agent's pick is a recommendation.
  if (isLiveProvider(state.provider)) {
    return { text: "Best quote", tone: "success" };
  }

  const winner = state.calls[winnerCallId];
  /** @type {OutcomeLabel} */
  const notConfirmed = { text: "Booking not confirmed", tone: "warning" };

  if (winner === undefined || state.winnerGone || winner.commandDelivered === false) {
    return notConfirmed;
  }

  if (winner.command !== "commit") {
    return null;
  }

  if (winner.status === "ended") {
    return { text: "Quoted", tone: "success" };
  }

  if (winner.status === "failed" || state.finishedAt !== null) {
    return notConfirmed;
  }

  return { text: "Booking...", tone: "pending" };
}

/**
 * @param {RunState} state
 * @returns {number}
 */
function countOpenCalls(state) {
  const openCalls = selectCalls(state).filter(
    (call) => FINISHED_CALL_STATUSES.includes(call.status) === false,
  );
  return openCalls.length;
}

/**
 * @param {number} count
 * @param {string} singular
 * @param {string} plural
 * @returns {string}
 */
function pluralize(count, singular, plural) {
  if (count === 1) {
    return `${count} ${singular}`;
  }

  return `${count} ${plural}`;
}

/**
 * @param {DecisionDeadline | null} deadline
 * @returns {string}
 */
function describeDeadline(deadline) {
  if (deadline === null) {
    return "When the decision window closes";
  }

  if (deadline.reason === "all-settled") {
    return "Once the last offers settle";
  }

  if (deadline.reason === "window") {
    return "When the decision window closes";
  }

  return "When the time limit is reached";
}

/**
 * @param {RunState} state
 * @returns {HeadAgentPlan}
 */
function planWhileCalling(state) {
  const counts = selectGridCounts(state);
  let doingNow = {
    title: "Asking for prices",
    detail: `${pluralize(counts.talking, "call", "calls")} talking`,
  };

  if (counts.dialing > 0) {
    doingNow = {
      title: "Dialing businesses",
      detail: `${pluralize(counts.dialing, "call", "calls")} connecting`,
    };
  }

  return {
    doingNow,
    next: {
      title: "Wait for the first quote",
      detail: "It starts the decision window",
    },
  };
}

/**
 * @param {RunState} state
 * @returns {HeadAgentPlan}
 */
function planWhileQuoting(state) {
  const openCalls = countOpenCalls(state);

  return {
    doingNow: {
      title: "Collecting quotes",
      detail: `${pluralize(openCalls, "call", "calls")} still open`,
    },
    next: {
      title: "Pick the lowest total",
      detail: describeDeadline(state.deadline),
    },
  };
}

/**
 * @param {RunState} state
 * @returns {HeadAgentPlan}
 */
function planWhileDeciding(state) {
  const leader = selectLeader(state);
  const quoteCount = selectStats(state).quoteCount;
  let nextTitle = "Report that no quotes came in";
  let nextDetail = "Nothing to book";

  if (leader !== null) {
    nextTitle = `Book ${leader.name}`;
    nextDetail = "Close every other call";
  }

  if (leader !== null && isLiveProvider(state.provider)) {
    nextTitle = `Recommend ${leader.name}`;
    nextDetail = "Live calls never book";
  }

  return {
    doingNow: {
      title: "Waiting for last offers",
      detail: `${pluralize(quoteCount, "quote", "quotes")} in`,
    },
    next: { title: nextTitle, detail: nextDetail },
  };
}

/**
 * @param {RunState} state
 * @returns {HeadAgentPlan}
 */
function planWhileBooking(state) {
  const leader = selectLeader(state);
  const outcome = selectOutcomeLabel(state);
  let winnerName = "the winner";
  let outcomeText = "Booking...";

  if (leader !== null) {
    winnerName = leader.name;
  }

  if (outcome !== null) {
    outcomeText = outcome.text;
  }

  const openCalls = countOpenCalls(state);

  return {
    doingNow: { title: `Booking ${winnerName}`, detail: outcomeText },
    next: {
      title: "Wrap up every call",
      detail: `${pluralize(openCalls, "call", "calls")} still ending`,
    },
  };
}

/**
 * @param {RunState} state
 * @returns {HeadAgentPlan}
 */
function planWhenDone(state) {
  const outcome = selectOutcomeLabel(state);
  let detail = "No quotes came in";

  if (outcome !== null) {
    detail = outcome.text;
  }

  return {
    doingNow: { title: "Run complete", detail },
    next: { title: "Review the breakdown", detail: "Every line is closed" },
  };
}

/**
 * Built from run status only, so the card never repeats AI text.
 * @param {RunState} state
 * @returns {HeadAgentPlan}
 */
export function selectHeadAgentPlan(state) {
  const status = selectRunStatus(state);

  if (status === "calling") {
    return planWhileCalling(state);
  }

  if (status === "quotes") {
    return planWhileQuoting(state);
  }

  // Until every call has settled, deciding still means gathering the rest of the quotes.
  const settling = state.deadline !== null && state.deadline.reason === "all-settled";

  if (status === "deciding" && settling === false && state.decision === null) {
    return planWhileQuoting(state);
  }

  if (status === "deciding") {
    return planWhileDeciding(state);
  }

  if (status === "booking") {
    return planWhileBooking(state);
  }

  return planWhenDone(state);
}

// Simulated calls answer the instant they dial, and "Answered 0.0s" tells the reader nothing.
const MIN_ANSWER_MS = 100;

/**
 * Only answering is reported today. Phone menus and holds join this list when a provider sends them.
 * @param {CallState} call
 * @returns {GettingThroughStep[]}
 */
export function selectGettingThrough(call) {
  if (call.dialedAt === null || call.answeredAt === null) {
    return [];
  }

  const afterMs = call.answeredAt - call.dialedAt;

  if (afterMs < MIN_ANSWER_MS) {
    return [];
  }

  return [{ kind: "answered", afterMs }];
}
