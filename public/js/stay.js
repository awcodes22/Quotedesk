// @ts-check
// Shared by the server and the new quote wizard, so the stay the user picks and the sentences the
// agent says on the phone are always built the same way.

/**
 * @typedef {"king" | "two-queens" | "any"} BedKey
 *
 * @typedef {{
 *   area: string,
 *   checkIn: string,
 *   checkOut: string,
 *   guests: number,
 *   bed: BedKey,
 * }} StayRequest
 */

/** @type {{ key: BedKey, label: string, phrase: string }[]} */
export const BEDS = [
  { key: "king", label: "1 king", phrase: "a king bed" },
  { key: "two-queens", label: "2 queens", phrase: "two queen beds" },
  { key: "any", label: "Any bed", phrase: "" },
];

export const MIN_GUESTS = 1;
export const MAX_GUESTS = 8;

// Every wizard call asks the same three things and never gives a name.
export const ASK_ABOUT = "free cancellation, whether breakfast is included, and whether there's a lower rate available";
export const ASK_ABOUT_SHORT = "cancellation, breakfast and lower rates";
export const GUEST_NAME = "a guest";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {number} count
 * @param {string} singular
 * @param {string} plural
 * @returns {string}
 */
function countOf(count, singular, plural) {
  if (count === 1) {
    return `1 ${singular}`;
  }

  return `${count} ${plural}`;
}

/**
 * Dates are read as calendar days, never through a time zone, so a stay never shifts by a day.
 * @param {string} isoDay
 * @returns {{ year: number, month: number, day: number }}
 */
function readDay(isoDay) {
  const parts = isoDay.split("-").map(Number);
  const year = parts[0];
  const month = parts[1];
  const day = parts[2];

  if (year === undefined || month === undefined || day === undefined || MONTHS[month - 1] === undefined) {
    throw new Error(`"${isoDay}" is not a date like 2026-11-20.`);
  }

  return { year, month, day };
}

/**
 * @param {string} isoDay
 * @returns {number}
 */
function dayNumber(isoDay) {
  const { year, month, day } = readDay(isoDay);
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

/**
 * @param {string} checkIn
 * @param {string} checkOut
 * @returns {number}
 */
export function countNights(checkIn, checkOut) {
  return dayNumber(checkOut) - dayNumber(checkIn);
}

/**
 * One day the way it is said, such as "November 20".
 * @param {string} isoDay
 * @returns {string}
 */
export function formatSpokenDay(isoDay) {
  const { month, day } = readDay(isoDay);
  return `${MONTHS[month - 1]} ${day}`;
}

/**
 * The caller reads this out loud, so it must sound like speech, never like 2026-11-20.
 * @param {string} checkIn
 * @param {string} checkOut
 * @returns {string}
 */
export function formatStayDates(checkIn, checkOut) {
  const start = readDay(checkIn);
  const end = readDay(checkOut);
  const startMonth = MONTHS[start.month - 1];
  const endMonth = MONTHS[end.month - 1];

  if (start.month === end.month) {
    return `${startMonth} ${start.day} to ${end.day}`;
  }

  return `${startMonth} ${start.day} to ${endMonth} ${end.day}`;
}

/**
 * @param {string} checkIn
 * @param {string} checkOut
 * @returns {string}
 */
export function buildDatesSentence(checkIn, checkOut) {
  const nights = countOf(countNights(checkIn, checkOut), "night", "nights");
  return `${formatStayDates(checkIn, checkOut)}, ${nights}`;
}

/**
 * The short form for pills and summaries, such as "Nov 20 to 22 · 2 nights".
 * @param {string} checkIn
 * @param {string} checkOut
 * @returns {string}
 */
export function formatShortDates(checkIn, checkOut) {
  const start = readDay(checkIn);
  const end = readDay(checkOut);
  const nights = countOf(countNights(checkIn, checkOut), "night", "nights");
  let range = `${SHORT_MONTHS[start.month - 1]} ${start.day} to ${end.day}`;

  if (start.month !== end.month) {
    range = `${SHORT_MONTHS[start.month - 1]} ${start.day} to ${SHORT_MONTHS[end.month - 1]} ${end.day}`;
  }

  return `${range} · ${nights}`;
}

/**
 * @param {number} guests
 * @returns {string}
 */
export function describeGuests(guests) {
  return countOf(guests, "guest", "guests");
}

/**
 * @param {BedKey} bed
 * @returns {{ key: BedKey, label: string, phrase: string } | undefined}
 */
function findBed(bed) {
  return BEDS.find((option) => option.key === bed);
}

/**
 * A plain sentence the agent can say, such as "one room with a king bed for 2 guests".
 * @param {Pick<StayRequest, "guests" | "bed">} stay
 * @returns {string}
 */
export function buildRequestSentence(stay) {
  const bed = findBed(stay.bed);
  const guests = describeGuests(stay.guests);

  if (bed === undefined || bed.phrase === "") {
    return `one room for ${guests}`;
  }

  return `one room with ${bed.phrase} for ${guests}`;
}

/**
 * The guests and bed in a few words, such as "2 guests · 1 king".
 * @param {Pick<StayRequest, "guests" | "bed">} stay
 * @returns {string}
 */
export function describeGuestsAndBed(stay) {
  const bed = findBed(stay.bed);

  if (bed === undefined) {
    return describeGuests(stay.guests);
  }

  return `${describeGuests(stay.guests)} · ${bed.label}`;
}

/**
 * The Places text search for the picked area.
 * @param {string} area
 * @returns {string}
 */
export function buildHotelSearch(area) {
  return `hotels in ${area.trim()}`;
}
