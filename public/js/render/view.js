// @ts-check
import { capitalize } from "../format.js";

/**
 * @typedef {import("../state.js").RunState} RunState
 * @typedef {import("../state.js").CallState} CallState
 * @typedef {import("../state.js").GridState} GridState
 * @typedef {import("../../../src/core/types").CallStatus} CallStatus
 * @typedef {import("../../../src/core/types").FieldLabel} FieldLabel
 * @typedef {import("../../../src/core/types").JobDetail} JobDetail
 * @typedef {import("../../../src/core/types").ReferencePrices} ReferencePrices
 * @typedef {import("../../../src/core/types").BusinessNoun} BusinessNoun
 *
 * @typedef {{
 *   id: string,
 *   title: string,
 *   request: string,
 *   industry: {
 *     id: string,
 *     label: string,
 *     clientNoun: string,
 *     businessNoun: BusinessNoun,
 *     fieldLabels?: Record<string, FieldLabel>,
 *   },
 *   reference?: ReferencePrices,
 *   details?: JobDetail[],
 *   decideWithinMs: number,
 *   maxTurns: number,
 *   contactName: string | null,
 *   businessCount: number,
 * }} JobListing
 *
 * @typedef {"all" | GridState} GridFilter
 * @typedef {"price" | "order"} GridSort
 *
 * @typedef {{
 *   state: RunState,
 *   now: number,
 *   listing: JobListing | null,
 *   selectedCallId: string | null,
 *   filter: GridFilter,
 *   search: string,
 *   sort: GridSort,
 *   ended: boolean,
 * }} View
 *
 * @typedef {"live" | "muted" | "alert" | "win" | "warning"} StatusTone
 * @typedef {{ text: string, tone: StatusTone }} StatusText
 * @typedef {{ text: string, isCatch: boolean }} KeyTerm
 */

/** @type {Record<CallStatus, StatusText>} */
const CALL_STATUS_TEXT = {
  queued: { text: "Queued", tone: "muted" },
  connecting: { text: "Dialing", tone: "live" },
  talking: { text: "Talking", tone: "live" },
  quoted: { text: "Quoted", tone: "live" },
  committed: { text: "Booking", tone: "live" },
  closed: { text: "Closing", tone: "live" },
  ended: { text: "Ended", tone: "muted" },
  failed: { text: "No answer", tone: "alert" },
  skipped: { text: "Not called", tone: "muted" },
};

/**
 * @param {CallStatus} status
 * @returns {StatusText}
 */
export function describeCallStatus(status) {
  return CALL_STATUS_TEXT[status];
}

/**
 * Stops counting once the run has finished.
 * @param {View} view
 * @returns {number}
 */
export function runElapsedMs(view) {
  const { startedAt, finishedAt } = view.state;

  if (startedAt === null) {
    return 0;
  }

  if (finishedAt !== null) {
    return finishedAt - startedAt;
  }

  return view.now - startedAt;
}

/**
 * Counts from the moment the call was dialed until it ended.
 * @param {CallState} call
 * @param {number} now
 * @returns {number}
 */
export function callElapsedMs(call, now) {
  if (call.dialedAt === null) {
    return 0;
  }

  if (call.endedAt !== null) {
    return call.endedAt - call.dialedAt;
  }

  return now - call.dialedAt;
}

/**
 * @param {View} view
 * @returns {Record<string, FieldLabel>}
 */
export function findFieldLabels(view) {
  if (view.listing === null || view.listing.industry.fieldLabels === undefined) {
    return {};
  }

  return view.listing.industry.fieldLabels;
}

/** @type {BusinessNoun} */
const DEFAULT_NOUN = { singular: "business", plural: "businesses" };

/**
 * @param {JobListing | null} listing
 * @returns {BusinessNoun}
 */
export function findBusinessNoun(listing) {
  if (listing === null) {
    return DEFAULT_NOUN;
  }

  return listing.industry.businessNoun;
}

/**
 * @param {View} view
 * @returns {boolean}
 */
export function isTextRun(view) {
  return view.state.provider === "text";
}

/**
 * A "no" answer is the catch, such as non-refundable, so it wins the single term on a card.
 * @param {Record<string, unknown>} fields
 * @param {Record<string, FieldLabel>} fieldLabels
 * @returns {KeyTerm | null}
 */
export function findKeyTerm(fields, fieldLabels) {
  /** @type {KeyTerm | null} */
  let firstPerk = null;

  for (const [key, label] of Object.entries(fieldLabels)) {
    const value = fields[key];

    if (value === false) {
      return { text: capitalize(label.no), isCatch: true };
    }

    if (value === true && firstPerk === null) {
      firstPerk = { text: capitalize(label.yes), isCatch: false };
    }
  }

  return firstPerk;
}
