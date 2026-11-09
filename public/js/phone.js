// @ts-check
// Shared by the server and the dashboard, so a number is checked and masked the same way on both sides.

// +1, then an area code and an exchange that can't start with 0 or 1.
const NORTH_AMERICAN_NUMBER = /^\+1[2-9]\d{2}[2-9]\d{6}$/;
const TEN_DIGITS = /^\d{10}$/;

/**
 * The last two digits are enough to tell numbers apart without revealing them.
 * @param {string} phone
 * @returns {string}
 */
export function maskPhone(phone) {
  const digits = phone.replace(/\D/g, "");
  const lastTwo = digits.slice(-2);
  return `+1 ••• ••• ••${lastTwo}`;
}

/**
 * People type numbers with spaces, dashes, dots and brackets, so those are dropped first.
 * Ten digits on their own are taken as North American, so +1 is added.
 * @param {string} input
 * @returns {string | null} The number as +1 and 10 digits, or null if it isn't North American.
 */
export function normalizeNorthAmericanNumber(input) {
  let compact = input.replace(/[\s().-]/g, "");

  if (TEN_DIGITS.test(compact)) {
    compact = `+1${compact}`;
  }

  if (NORTH_AMERICAN_NUMBER.test(compact) === false) {
    return null;
  }

  return compact;
}
