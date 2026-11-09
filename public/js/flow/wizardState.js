// @ts-check
// The new quote wizard's state. It lives in this module's memory only: nothing is written to
// browser storage, cookies or the URL, so a reload starts a fresh quote.
import {
  ASK_ABOUT_SHORT,
  buildDatesSentence,
  countNights,
  describeGuestsAndBed,
  formatShortDates,
  MAX_GUESTS,
  MIN_GUESTS,
} from "../stay.js";

/**
 * @typedef {import("../stay.js").StayRequest} StayRequest
 * @typedef {import("../stay.js").BedKey} BedKey
 * @typedef {import("./hotelList.js").PlaceHotel} PlaceHotel
 *
 * @typedef {"where" | "when" | "hotels"} StepKey
 * @typedef {{ key: StepKey, title: string, question: string, hint: string }} StepInfo
 *
 * @typedef {{
 *   step: number,
 *   reached: number,
 *   area: string,
 *   checkIn: string,
 *   checkOut: string,
 *   guests: number,
 *   bed: BedKey | null,
 *   hotels: PlaceHotel[],
 *   searchedFor: string,
 *   sample: boolean,
 *   picked: string[],
 * }} WizardState
 *
 * @typedef {{ label: string, value: string }} SummaryLine
 */

/** @type {StepInfo[]} */
export const STEPS = [
  {
    key: "where",
    title: "Where",
    question: "Where are you staying?",
    hint: "We'll find hotels there to call.",
  },
  {
    key: "when",
    title: "When and who",
    question: "When and who?",
    hint: "The agent asks for the total for these nights.",
  },
  {
    key: "hotels",
    title: "Hotels",
    question: "Which hotels should we call?",
    hint: "Pick up to the limit. Everything is called at once.",
  },
];

const MAX_NIGHTS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {Date} now
 * @returns {string}
 */
export function todayIso(now) {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * @param {string} isoDay
 * @param {number} days
 * @returns {string}
 */
export function addDays(isoDay, days) {
  const time = Date.parse(`${isoDay}T00:00:00Z`) + days * DAY_MS;
  return new Date(time).toISOString().slice(0, 10);
}

/** @returns {WizardState} */
export function createWizardState() {
  return {
    step: 0,
    reached: 0,
    area: "",
    checkIn: "",
    checkOut: "",
    guests: 2,
    bed: null,
    hotels: [],
    searchedFor: "",
    sample: false,
    picked: [],
  };
}

/**
 * @param {string} checkIn
 * @param {string} checkOut
 * @param {string} today
 * @returns {string | null} Why the dates don't work, or null when they do.
 */
export function validateDates(checkIn, checkOut, today) {
  if (checkIn === "" || checkOut === "") {
    return null;
  }

  if (checkIn < today) {
    return "Check-in can't be in the past.";
  }

  if (checkOut <= checkIn) {
    return "Check-out has to be after check-in.";
  }

  if (countNights(checkIn, checkOut) > MAX_NIGHTS) {
    return `Stays of up to ${MAX_NIGHTS} nights only.`;
  }

  return null;
}

/**
 * @param {WizardState} state
 * @param {number} index
 * @param {string} today
 * @returns {boolean}
 */
export function isStepValid(state, index, today) {
  const step = STEPS[index];

  if (step === undefined) {
    return false;
  }

  if (step.key === "where") {
    return state.area.trim().length >= 2;
  }

  if (step.key === "when") {
    const datesComplete = state.checkIn !== "" && state.checkOut !== "";
    const datesValid = datesComplete && validateDates(state.checkIn, state.checkOut, today) === null;
    const guestsValid = state.guests >= MIN_GUESTS && state.guests <= MAX_GUESTS;
    return datesValid && guestsValid && state.bed !== null;
  }

  return state.picked.length > 0;
}

/**
 * The "Your stay" summary in the sidebar. A line appears once its step is completed.
 * @param {WizardState} state
 * @returns {SummaryLine[]}
 */
export function summarizeStay(state) {
  /** @type {SummaryLine[]} */
  const lines = [];

  if (state.reached > 0) {
    lines.push({ label: "Where", value: state.area.trim() });
  }

  if (state.reached > 1 && state.bed !== null) {
    lines.push({ label: "When", value: formatShortDates(state.checkIn, state.checkOut) });
    lines.push({ label: "Who", value: describeGuestsAndBed({ guests: state.guests, bed: state.bed }) });
  }

  if (state.picked.length > 0) {
    lines.push({ label: "Hotels", value: `${state.picked.length} picked` });
  }

  return lines;
}

/**
 * What the server receives. It checks everything again, including the dates against its own clock.
 * @param {WizardState} state
 * @returns {StayRequest}
 */
export function buildStayPayload(state) {
  let bed = state.bed;

  if (bed === null) {
    bed = "any";
  }

  return {
    area: state.area.trim(),
    checkIn: state.checkIn,
    checkOut: state.checkOut,
    guests: state.guests,
    bed,
  };
}

/**
 * What the agent will ask, shown before any call is placed.
 * @param {StayRequest} stay
 * @returns {SummaryLine[]}
 */
export function describeAgentAsks(stay) {
  return [
    { label: "Dates", value: buildDatesSentence(stay.checkIn, stay.checkOut) },
    { label: "Guests and bed", value: describeGuestsAndBed(stay) },
    { label: "Asks about", value: ASK_ABOUT_SHORT },
  ];
}

/**
 * The fixed stay for "Try it on yourself": downtown Toronto, two nights starting two weeks out.
 * @param {string} today
 * @returns {StayRequest}
 */
export function buildSampleStay(today) {
  const checkIn = addDays(today, 14);

  return {
    area: "downtown Toronto",
    checkIn,
    checkOut: addDays(checkIn, 2),
    guests: 2,
    bed: "king",
  };
}
