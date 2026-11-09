// @ts-check
// Everything the run page shows, worked out from the run state alone. Nothing here touches the page,
// so the same functions drive the screen and the tests.
import { formatClock, formatMoney } from "../format.js";
import { PRICE_SCALE, percentAboveBest } from "../price.js";
import { endedWithoutPrice, isNoAnswer, isSelfTestRun, selectCalls, selectRanking } from "../state.js";
import { countNights, formatShortDates } from "../stay.js";

/**
 * @typedef {import("../state.js").RunState} RunState
 * @typedef {import("../state.js").CallState} CallState
 * @typedef {import("../state.js").RankedQuote} RankedQuote
 *
 * @typedef {"talking" | "hold" | "menu" | "ringing" | "quoted" | "no-answer" | "no-quote"} CallKind
 * @typedef {"live" | "test" | "done"} PagePhase
 * @typedef {"named" | "medium" | "small"} TileSize
 *
 * @typedef {{ kind: CallKind, label: string, count: number }} StatusCount
 * @typedef {{ finished: number, total: number, pct: number }} Progress
 * @typedef {{
 *   badge: "waiting" | "ranking",
 *   headline: string,
 *   sub: string,
 *   quoted: string,
 *   decides: string,
 * }} HeadAgentModel
 * @typedef {{
 *   callId: string,
 *   name: string,
 *   kind: CallKind,
 *   price: string | null,
 *   color: string | null,
 *   textColor: string | null,
 *   selected: boolean,
 * }} TileModel
 * @typedef {{ icon: string, text: string, kind: "area" | "dates" | "guests" | "bed" | "asks" }} StayPill
 */

/** @type {{ kind: CallKind, label: string }[]} */
export const LIVE_STATUSES = [
  { kind: "talking", label: "Talking" },
  { kind: "hold", label: "On hold" },
  { kind: "menu", label: "Phone menu" },
  { kind: "ringing", label: "Ringing" },
  { kind: "quoted", label: "Quoted" },
  { kind: "no-answer", label: "No answer" },
  { kind: "no-quote", label: "No quote" },
];

/** @type {CallKind[]} */
export const DONE_STATUSES = ["quoted", "no-answer", "no-quote"];

/** @type {import("../../../src/core/types").CallStatus[]} */
const FINISHED_STATUSES = ["ended", "failed", "skipped"];

export const TOP_COUNT = 3;
const NAMED_TILE_LIMIT = 12;
const MEDIUM_TILE_LIMIT = 60;
const ASKS_PILL = "Cancel · breakfast · lower rate";

/**
 * Phone menus and holds aren't reported by any provider yet, so no call is ever put in those two.
 * @param {CallState} call
 * @returns {CallKind}
 */
export function classifyCall(call) {
  if (call.quote !== null) {
    return "quoted";
  }

  if (isNoAnswer(call)) {
    return "no-answer";
  }

  if (endedWithoutPrice(call) || FINISHED_STATUSES.includes(call.status)) {
    return "no-quote";
  }

  if (call.status === "queued" || call.status === "connecting") {
    return "ringing";
  }

  return "talking";
}

/**
 * @param {RunState} state
 * @returns {PagePhase}
 */
export function selectPhase(state) {
  if (state.finishedAt !== null) {
    return "done";
  }

  if (isSelfTestRun(state)) {
    return "test";
  }

  return "live";
}

/**
 * @param {RunState} state
 * @returns {Progress}
 */
export function selectProgress(state) {
  const calls = selectCalls(state);
  const finished = calls.filter((call) => FINISHED_STATUSES.includes(call.status)).length;
  let pct = 0;

  if (calls.length > 0) {
    pct = Math.round((finished / calls.length) * 100);
  }

  return { finished, total: calls.length, pct };
}

/**
 * The live list shows all seven, the done list only the three a call can end in.
 * @param {RunState} state
 * @returns {StatusCount[]}
 */
export function selectStatusCounts(state) {
  /** @type {Record<CallKind, number>} */
  const counts = { talking: 0, hold: 0, menu: 0, ringing: 0, quoted: 0, "no-answer": 0, "no-quote": 0 };

  for (const call of selectCalls(state)) {
    counts[classifyCall(call)] += 1;
  }

  let shown = LIVE_STATUSES;

  if (state.finishedAt !== null) {
    shown = LIVE_STATUSES.filter((status) => DONE_STATUSES.includes(status.kind));
  }

  return shown.map((status) => ({ ...status, count: counts[status.kind] }));
}

/**
 * @param {number} rank
 * @returns {string}
 */
function ordinal(rank) {
  const lastTwo = rank % 100;

  if (lastTwo >= 11 && lastTwo <= 13) {
    return `${rank}th`;
  }

  const suffixes = ["th", "st", "nd", "rd"];
  const suffix = suffixes[rank % 10];

  if (suffix === undefined) {
    return `${rank}th`;
  }

  return `${rank}${suffix}`;
}

/**
 * @param {RunState} state
 * @returns {import("../../../src/core/types").Quote | null}
 */
function findLatestQuote(state) {
  let latest = null;

  for (const call of selectCalls(state)) {
    if (call.quote !== null && (latest === null || call.quote.receivedAt > latest.receivedAt)) {
      latest = call.quote;
    }
  }

  return latest;
}

/**
 * The leader just before the latest quote arrived: the cheapest of the earlier quotes.
 * @param {RankedQuote[]} ranking
 * @param {string} latestCallId
 * @returns {RankedQuote | null}
 */
function findPreviousLeader(ranking, latestCallId) {
  const others = ranking.filter((quote) => quote.callId !== latestCallId);
  const previous = others[0];

  if (previous === undefined) {
    return null;
  }

  return previous;
}

/**
 * @param {RunState} state
 * @param {number} now
 * @returns {string}
 */
function describeCountdown(state, now) {
  if (state.deadline === null) {
    return "Decides after the first quote";
  }

  const remaining = Math.max(0, state.deadline.deadlineAt - now);
  return `${formatClock(remaining)} until it decides`;
}

/**
 * @param {RunState} state
 * @param {RankedQuote[]} ranking
 * @returns {{ headline: string, sub: string } | null}
 */
function describeLatestQuote(state, ranking) {
  const latest = findLatestQuote(state);

  if (latest === null) {
    return null;
  }

  const ranked = ranking.find((quote) => quote.callId === latest.callId);
  const leader = ranking[0];

  if (ranked === undefined || leader === undefined) {
    return null;
  }

  if (ranked.rank === 1) {
    const previous = findPreviousLeader(ranking, ranked.callId);
    let sub = "The first quote is in.";

    if (previous !== null) {
      sub = `${formatMoney(previous.total - ranked.total)} less than ${previous.name}`;
    }

    return { headline: `New leader: ${ranked.name} ${formatMoney(ranked.total)}`, sub };
  }

  return {
    headline: `${ranked.name} quoted ${formatMoney(ranked.total)} · ranked ${ordinal(ranked.rank)}`,
    sub: `${formatMoney(ranked.gapToLeader)} above the leader, ${leader.name}`,
  };
}

/**
 * Only states an event backs up: waiting, a quote ranked, a new leader, or deciding.
 * @param {RunState} state
 * @param {number} now
 * @returns {HeadAgentModel}
 */
export function selectHeadAgent(state, now) {
  const ranking = selectRanking(state);
  const progress = selectProgress(state);
  const quotedCount = selectCalls(state).filter((call) => call.quote !== null).length;
  const base = {
    quoted: `${quotedCount} of ${progress.total} quoted`,
    decides: describeCountdown(state, now),
  };
  const testRun = isSelfTestRun(state);
  const allFinished = progress.total > 0 && progress.finished === progress.total;

  if (state.decision !== null || allFinished) {
    return { ...base, badge: "ranking", headline: "All calls finished, deciding", sub: "Picking the lowest total with taxes." };
  }

  const leader = ranking[0];

  if (testRun && leader !== undefined) {
    return { ...base, badge: "ranking", headline: `Your quote: ${formatMoney(leader.total)}`, sub: "The head agent ranks it as soon as the call ends." };
  }

  if (testRun) {
    return { ...base, badge: "waiting", headline: "Waiting for your quote", sub: "Answer as the front desk and give a price." };
  }

  const latest = describeLatestQuote(state, ranking);

  if (latest === null) {
    return { ...base, badge: "waiting", headline: "Waiting for the first quote", sub: `${progress.total - progress.finished} calls in progress` };
  }

  return { ...base, badge: "ranking", ...latest };
}

/**
 * @param {RunState} state
 * @returns {RankedQuote[]}
 */
export function selectTopThree(state) {
  return selectRanking(state).slice(0, TOP_COUNT);
}

/**
 * The two after the winner, for the done page.
 * @param {RunState} state
 * @returns {RankedQuote[]}
 */
export function selectRunnersUp(state) {
  return selectRanking(state).slice(1, TOP_COUNT);
}

/**
 * @param {number} count
 * @returns {TileSize}
 */
export function selectTileSize(count) {
  if (count <= NAMED_TILE_LIMIT) {
    return "named";
  }

  if (count <= MEDIUM_TILE_LIMIT) {
    return "medium";
  }

  return "small";
}

/**
 * @param {number} total
 * @param {number} best
 * @returns {{ color: string, textColor: string }}
 */
function priceStep(total, best) {
  const pct = percentAboveBest(total, best);
  const step = PRICE_SCALE.find((candidate) => pct <= candidate.maxPctAboveBest);

  if (step === undefined) {
    return { color: "#FEDF89", textColor: "#B54708" };
  }

  return step;
}

/**
 * @param {CallState} call
 * @param {number | null} best
 * @param {string | null} selectedCallId
 * @returns {TileModel}
 */
export function buildTile(call, best, selectedCallId) {
  const kind = classifyCall(call);
  let price = null;
  let color = null;
  let textColor = null;

  if (call.quote !== null && best !== null) {
    const step = priceStep(call.quote.total, best);
    price = String(call.quote.total);
    color = step.color;
    textColor = step.textColor;
  }

  return { callId: call.callId, name: call.name, kind, price, color, textColor, selected: call.callId === selectedCallId };
}

/**
 * @param {RunState} state
 * @returns {number | null}
 */
export function selectBest(state) {
  const leader = selectRanking(state)[0];

  if (leader === undefined) {
    return null;
  }

  return leader.total;
}

/**
 * @param {Record<string, unknown>} fields
 * @returns {string}
 */
export function describeTerms(fields) {
  const parts = [];

  if (fields.freeCancellation === true) {
    parts.push("Free cancellation");
  }

  if (fields.freeCancellation === false) {
    parts.push("Non-refundable");
  }

  if (fields.includesTaxes === true) {
    parts.push("Taxes included");
  }

  if (fields.includesTaxes === false) {
    parts.push("Plus taxes");
  }

  if (parts.length === 0) {
    return "Terms not mentioned";
  }

  return parts.join(" · ");
}

/**
 * Breakfast is only ever in the notes, as the business said it.
 * @param {string[]} notes
 * @returns {"included" | "extra" | null}
 */
export function readBreakfast(notes) {
  const note = notes.find((text) => /breakfast/i.test(text));

  if (note === undefined) {
    return null;
  }

  if (/not included|isn't included|extra|\$|charge|costs?/i.test(note)) {
    return "extra";
  }

  if (/included|complimentary|free/i.test(note)) {
    return "included";
  }

  return null;
}

/**
 * @param {CallState} call
 * @returns {{ total: string, cancel: string, breakfast: string }}
 */
export function describeQuoteTiles(call) {
  let total = "Not yet";
  let cancel = "Not yet";
  let breakfast = "Not yet";
  const breakfastNote = readBreakfast(call.notes);

  if (call.quote !== null) {
    total = formatMoney(call.quote.total);
  }

  if (call.quote !== null && call.quote.fields.freeCancellation === true) {
    cancel = "Free";
  }

  if (call.quote !== null && call.quote.fields.freeCancellation === false) {
    cancel = "Non-refundable";
  }

  if (breakfastNote === "included") {
    breakfast = "Included";
  }

  if (breakfastNote === "extra") {
    breakfast = "Extra";
  }

  return { total, cancel, breakfast };
}

/**
 * Why a run ended with nothing to show.
 * @param {RunState} state
 * @returns {string}
 */
export function describeNoQuotes(state) {
  const calls = selectCalls(state);
  const unanswered = calls.filter((call) => isNoAnswer(call)).length;

  if (isSelfTestRun(state)) {
    return "The test call ended without a price.";
  }

  if (calls.length > 0 && unanswered === calls.length) {
    return "None of the hotels picked up.";
  }

  return `${calls.length - unanswered} hotels answered, but none gave a price.`;
}

/**
 * The stay as pills: area, dates, guests, bed and, while live on a wizard run, what the agent asks.
 * @param {RunState} state
 * @returns {StayPill[]}
 */
export function selectStayPills(state) {
  const job = state.job;
  /** @type {StayPill[]} */
  const pills = [];

  if (job === null) {
    return pills;
  }

  let area = job.title;

  if (job.location !== undefined) {
    area = job.location;
  }

  pills.push({ icon: "map-pin", text: area, kind: "area" });

  if (job.stay !== undefined) {
    pills.push({ icon: "calendar", text: formatShortDates(job.stay.checkIn, job.stay.checkOut), kind: "dates" });
  }

  let details = /** @type {import("../../../src/core/types").JobDetail[]} */ ([]);

  if (job.details !== undefined) {
    details = job.details;
  }

  const guestsDetail = details.find((detail) => detail.label === "Guests");

  if (guestsDetail !== undefined) {
    const [guests, bed] = guestsDetail.value.split(" · ");

    if (guests !== undefined) {
      pills.push({ icon: "users", text: guests, kind: "guests" });
    }

    if (bed !== undefined) {
      pills.push({ icon: "bed", text: bed, kind: "bed" });
    }
  }

  const live = state.finishedAt === null;

  if (live && job.callBrief !== undefined && isSelfTestRun(state) === false) {
    pills.push({ icon: "square-check", text: ASKS_PILL, kind: "asks" });
  }

  return pills;
}

/**
 * @param {RunState} state
 * @returns {number}
 */
export function selectNights(state) {
  const job = state.job;

  if (job === null || job.stay === undefined) {
    return 0;
  }

  return countNights(job.stay.checkIn, job.stay.checkOut);
}

/**
 * The four "How it went" numbers. The spread only makes sense with two or more quotes.
 * @param {RunState} state
 * @returns {{ label: string, value: string }[]}
 */
export function selectDoneStats(state) {
  const ranking = selectRanking(state);
  const calls = selectCalls(state);
  let duration = 0;

  if (state.startedAt !== null && state.finishedAt !== null) {
    duration = state.finishedAt - state.startedAt;
  }

  const stats = [
    { label: "Hotels called", value: String(calls.length) },
    { label: "Quotes", value: String(ranking.length) },
    { label: "Start to finish", value: formatClock(duration) },
  ];
  const best = ranking[0];
  const highest = ranking[ranking.length - 1];

  if (ranking.length >= 2 && best !== undefined && highest !== undefined) {
    stats.push({ label: "Best vs highest", value: `${formatMoney(highest.total - best.total)} less` });
  }

  return stats;
}

/**
 * Test calls only: where the call is, read from run events.
 * @param {RunState} state
 * @returns {{ text: string, phase: "done" | "active" | "todo" }[]}
 */
export function selectTestSteps(state) {
  const texts = ["It calls you", "You answer", "Your quote lands", "Head agent picks"];
  const call = selectCalls(state)[0];
  let reached = 0;

  if (call !== undefined && call.answeredAt !== null) {
    reached = 1;
  }

  if (call !== undefined && call.quote !== null) {
    reached = 2;
  }

  if (state.decision !== null) {
    reached = 3;
  }

  const finished = state.finishedAt !== null;

  return texts.map((text, index) => {
    /** @type {"done" | "active" | "todo"} */
    let phase = "todo";

    if (finished || index < reached) {
      phase = "done";
    } else if (index === reached) {
      phase = "active";
    }

    return { text, phase };
  });
}
