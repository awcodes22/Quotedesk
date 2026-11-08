// @ts-check

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;

/**
 * Whole dollars stay whole, and anything with cents shows both digits.
 * @param {number} amount
 * @returns {string}
 */
export function formatMoney(amount) {
  let fractionDigits = 2;

  if (Number.isInteger(amount)) {
    fractionDigits = 0;
  }

  const digits = Math.abs(amount).toLocaleString("en-US", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });

  if (amount < 0) {
    return `-$${digits}`;
  }

  return `$${digits}`;
}

/**
 * @param {number} amount
 * @returns {string}
 */
export function formatSignedMoney(amount) {
  if (amount > 0) {
    return `+${formatMoney(amount)}`;
  }

  return formatMoney(amount);
}

/**
 * @param {number} pct
 * @returns {string}
 */
export function formatSignedPercent(pct) {
  const rounded = Math.round(pct);

  if (rounded > 0) {
    return `+${rounded}%`;
  }

  return `${rounded}%`;
}

/**
 * Minutes and seconds, as in 1:05. Negative time shows as 0:00.
 * @param {number} ms
 * @returns {string}
 */
export function formatClock(ms) {
  let totalSeconds = 0;

  if (ms > 0) {
    totalSeconds = Math.floor(ms / SECOND_MS);
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const paddedSeconds = String(seconds).padStart(2, "0");
  return `${minutes}:${paddedSeconds}`;
}

/**
 * @param {number} ms
 * @returns {string}
 */
export function formatSeconds(ms) {
  const seconds = ms / SECOND_MS;
  return `${seconds.toFixed(1)}s`;
}

/**
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (ms % MINUTE_MS === 0) {
    return `${ms / MINUTE_MS} min`;
  }

  return `${Math.round(ms / SECOND_MS)} s`;
}

/**
 * @param {string} name
 * @returns {string}
 */
export function initials(name) {
  const words = name.split(/\s+/).filter((word) => word !== "");
  const letters = words.slice(0, 2).map((word) => word.charAt(0));
  return letters.join("").toUpperCase();
}

/**
 * Turns a quote field key such as freeCancellation into "Free cancellation".
 * @param {string} key
 * @returns {string}
 */
export function labelFromKey(key) {
  const spaced = key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return capitalize(spaced);
}

/**
 * @param {string} text
 * @returns {string}
 */
export function capitalize(text) {
  if (text === "") {
    return text;
  }

  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * @param {number} count
 * @param {string} singular
 * @param {string} plural
 * @returns {string}
 */
export function pluralize(count, singular, plural) {
  if (count === 1) {
    return `${count} ${singular}`;
  }

  return `${count} ${plural}`;
}
