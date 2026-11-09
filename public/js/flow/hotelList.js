// @ts-check
// The hotels a search returned, ready to pick from.

/**
 * @typedef {{
 *   placeId: string,
 *   name: string,
 *   address: string,
 *   phone: string,
 *   rating: number | null,
 *   reviewCount: number | null,
 *   priceLevel: string | null,
 *   website: string | null,
 *   tollFree: boolean,
 * }} PlaceHotel
 */

/**
 * Missing values sort last.
 * @param {number | null} a
 * @param {number | null} b
 * @returns {number}
 */
function higherFirst(a, b) {
  if (a === b) {
    return 0;
  }

  if (a === null) {
    return 1;
  }

  if (b === null) {
    return -1;
  }

  return b - a;
}

/**
 * @param {PlaceHotel} a
 * @param {PlaceHotel} b
 * @returns {number}
 */
function byRating(a, b) {
  const rating = higherFirst(a.rating, b.rating);

  if (rating !== 0) {
    return rating;
  }

  return higherFirst(a.reviewCount, b.reviewCount);
}

/**
 * Toll-free numbers reach a chain's call center, which rarely quotes the local desk's rate, so
 * they are never offered. The rest are best rated first, with more reviews breaking a tie.
 * @param {PlaceHotel[]} hotels
 * @returns {PlaceHotel[]}
 */
export function listCallableHotels(hotels) {
  const callable = hotels.filter((hotel) => hotel.tollFree === false);
  callable.sort(byRating);
  return callable;
}

/**
 * The "Pick top N" shortcut: the first hotels in the list.
 * @param {PlaceHotel[]} shown
 * @param {number} max
 * @returns {string[]}
 */
export function pickTop(shown, max) {
  return shown.slice(0, max).map((hotel) => hotel.placeId);
}
