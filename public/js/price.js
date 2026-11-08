// @ts-check

/**
 * @typedef {{ from: number, to: number, count: number, color: string }} HistogramBin
 */

// Cheapest to priciest. Each step is a percentage above the best quote, so any industry fits.
export const PRICE_SCALE = [
  { maxPctAboveBest: 0, color: "#12B76A" },
  { maxPctAboveBest: 3, color: "#A6F4C5" },
  { maxPctAboveBest: 8, color: "#D1FADF" },
  { maxPctAboveBest: 13, color: "#FEF0C7" },
  { maxPctAboveBest: Infinity, color: "#FEDF89" },
];

export const HISTOGRAM_BIN_COUNT = 10;

/**
 * @param {number} total
 * @param {number} best
 * @returns {number}
 */
export function percentAboveBest(total, best) {
  if (best <= 0) {
    return 0;
  }

  return ((total - best) / best) * 100;
}

/**
 * @param {number} total
 * @param {number} best
 * @returns {string}
 */
export function priceColor(total, best) {
  const pctAboveBest = percentAboveBest(total, best);

  for (const step of PRICE_SCALE) {
    if (pctAboveBest <= step.maxPctAboveBest) {
      return step.color;
    }
  }

  const priciest = PRICE_SCALE[PRICE_SCALE.length - 1];
  let fallback = "#FEDF89";

  if (priciest !== undefined) {
    fallback = priciest.color;
  }

  return fallback;
}

/**
 * @param {number} lowest
 * @param {number} width
 * @param {number} index
 * @returns {HistogramBin}
 */
function createBin(lowest, width, index) {
  const from = lowest + width * index;
  const to = from + width;
  const color = priceColor(from, lowest);
  return { from, to, count: 0, color };
}

/**
 * @param {number} total
 * @param {number} lowest
 * @param {number} width
 * @returns {number}
 */
function findBinIndex(total, lowest, width) {
  if (width === 0) {
    return 0;
  }

  const index = Math.floor((total - lowest) / width);

  // The highest quote sits on the last bin's upper edge, so it belongs to that bin.
  if (index >= HISTOGRAM_BIN_COUNT) {
    return HISTOGRAM_BIN_COUNT - 1;
  }

  return index;
}

/**
 * Ten equal bins from the lowest quote to the highest, colored by where each bin starts.
 * @param {number[]} totals
 * @returns {HistogramBin[]}
 */
export function buildHistogram(totals) {
  if (totals.length === 0) {
    return [];
  }

  const lowest = Math.min(...totals);
  const highest = Math.max(...totals);
  const width = (highest - lowest) / HISTOGRAM_BIN_COUNT;
  const bins = [];

  for (let index = 0; index < HISTOGRAM_BIN_COUNT; index += 1) {
    bins.push(createBin(lowest, width, index));
  }

  for (const total of totals) {
    const bin = bins[findBinIndex(total, lowest, width)];

    if (bin !== undefined) {
      bin.count += 1;
    }
  }

  return bins;
}
