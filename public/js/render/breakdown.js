// @ts-check
import { el, icon } from "../dom.js";
import {
  capitalize,
  formatClock,
  formatMoney,
  formatSignedMoney,
  formatSignedPercent,
  initials,
  pluralize,
} from "../format.js";
import { buildHistogram, priceColor, priceTextColor } from "../price.js";
import { findBusinessNoun } from "./view.js";

/**
 * @typedef {import("../../../src/api/summary").RunSummary} RunSummary
 * @typedef {import("../../../src/api/summary").SummaryQuote} SummaryQuote
 * @typedef {import("../../../src/api/summary").Milestone} Milestone
 * @typedef {import("../../../src/core/types").PriceCheckRow} PriceCheckRow
 * @typedef {import("../../../src/core/types").FieldLabel} FieldLabel
 * @typedef {import("./view.js").JobListing} JobListing
 *
 * @typedef {{ summary: RunSummary, listing: JobListing | null }} BreakdownData
 * @typedef {{ swatch: string, label: string, value: string, tone: string, detail: string }} Tile
 */

const TABLE_ROWS = 9;
const EMPTY_VALUE = "—";

/** @type {Record<Milestone["key"], string>} */
const MILESTONE_COLORS = {
  dialed: "#2563EB",
  "first-quote": "#6CE9A6",
  decided: "#1C1917",
  finished: "#16A34A",
};

/**
 * @param {BreakdownData} data
 * @returns {string}
 */
function liveViewHref(data) {
  return `/runs/${encodeURIComponent(data.summary.runId)}`;
}

/**
 * @param {BreakdownData} data
 * @returns {Record<string, FieldLabel>}
 */
function findFieldLabels(data) {
  if (data.listing === null || data.listing.industry.fieldLabels === undefined) {
    return {};
  }

  return data.listing.industry.fieldLabels;
}

/**
 * @param {number} at
 * @returns {string}
 */
function formatStartTime(at) {
  return new Date(at).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * @param {BreakdownData} data
 * @returns {HTMLElement}
 */
function renderTitleRow(data) {
  const { summary } = data;
  const noun = findBusinessNoun(data.listing);
  const called = pluralize(summary.counts.calls, noun.singular, noun.plural);
  const subtitle = `${summary.job.title} · ${called} called · ${formatStartTime(summary.startedAt)}`;

  return el("div", { class: "breakdown-title-row" }, [
    el("a", { class: "button", href: liveViewHref(data) }, [
      icon("arrow-left", 16),
      "Back to live view",
    ]),
    el("h1", { class: "breakdown-title" }, ["Run breakdown"]),
    el("span", { class: "breakdown-subtitle" }, [subtitle]),
  ]);
}

/**
 * @param {RunSummary} summary
 * @returns {Tile}
 */
function buildBookedTile(summary) {
  const winner = summary.winner;

  if (winner === null) {
    return { swatch: "#12B76A", label: "Booked at", value: EMPTY_VALUE, tone: "muted", detail: "No quotes came in" };
  }

  if (summary.bookingConfirmed === true) {
    return { swatch: "#12B76A", label: "Booked at", value: formatMoney(winner.total), tone: "win", detail: winner.businessName };
  }

  return {
    swatch: "#FEC84B",
    label: "Booking not confirmed",
    value: formatMoney(winner.total),
    tone: "warning",
    detail: winner.businessName,
  };
}

/**
 * @param {RunSummary} summary
 * @returns {Tile}
 */
function buildSavedTile(summary) {
  const { savedVsMedian, median } = summary.stats;

  if (savedVsMedian === null || median === null) {
    return { swatch: "#A6F4C5", label: "Saved vs median", value: EMPTY_VALUE, tone: "muted", detail: "" };
  }

  return {
    swatch: "#A6F4C5",
    label: "Saved vs median",
    value: formatMoney(savedVsMedian),
    tone: "win",
    detail: `Median quote ${formatMoney(median)}`,
  };
}

/**
 * @param {BreakdownData} data
 * @returns {Tile}
 */
function buildTimeTile(data) {
  const noun = findBusinessNoun(data.listing);
  const calls = data.summary.counts.calls;

  return {
    swatch: "#A4BCFD",
    label: "Total time",
    value: formatClock(data.summary.durationMs),
    tone: "plain",
    detail: `${pluralize(calls, noun.singular, noun.plural)} called`,
  };
}

/**
 * @param {RunSummary} summary
 * @returns {Tile}
 */
function buildReferenceTile(summary) {
  const reference = summary.job.reference;
  const pct = summary.stats.vsReferencePct;
  const best = summary.stats.best;

  if (reference === undefined || reference.total === undefined || pct === null || best === null) {
    return { swatch: "#FEC84B", label: "vs listed online", value: EMPTY_VALUE, tone: "muted", detail: "No listed price" };
  }

  const difference = best - reference.total;
  let detail = `${formatMoney(reference.total)} listed, ${formatMoney(difference)} more`;
  let tone = "warning";

  if (difference <= 0) {
    detail = `${formatMoney(reference.total)} listed, ${formatMoney(-difference)} less`;
    tone = "win";
  }

  return {
    swatch: "#FEC84B",
    label: "vs listed online",
    value: formatSignedPercent(pct),
    tone,
    detail,
  };
}

/**
 * @param {Tile} tile
 * @returns {HTMLElement}
 */
function renderTile(tile) {
  const swatch = el("span", { class: "swatch" });
  swatch.style.background = tile.swatch;

  return el("div", { class: "card breakdown-tile" }, [
    el("span", { class: "breakdown-tile-label" }, [swatch, tile.label]),
    el("span", { class: `breakdown-tile-value tabular tone-${tile.tone}` }, [tile.value]),
    el("span", { class: "breakdown-tile-detail" }, [tile.detail]),
  ]);
}

/**
 * @param {BreakdownData} data
 * @returns {HTMLElement}
 */
function renderTiles(data) {
  const tiles = [
    buildBookedTile(data.summary),
    buildSavedTile(data.summary),
    buildTimeTile(data),
    buildReferenceTile(data.summary),
  ];

  return el("div", { class: "breakdown-tiles" }, tiles.map(renderTile));
}

/**
 * Every yes/no field the industry names, with the catch flagged so it can stand out.
 * @param {SummaryQuote} quote
 * @param {Record<string, FieldLabel>} fieldLabels
 * @returns {{ text: string, hasCatch: boolean }}
 */
function describeTerms(quote, fieldLabels) {
  const phrases = [];
  let hasCatch = false;

  for (const [key, label] of Object.entries(fieldLabels)) {
    const value = quote.fields[key];

    if (value === true) {
      phrases.push(label.yes);
    }

    if (value === false) {
      phrases.push(label.no);
      hasCatch = true;
    }
  }

  return { text: capitalize(phrases.join(" · ")), hasCatch };
}

/**
 * @param {SummaryQuote} quote
 * @param {boolean | null} bookingConfirmed
 * @returns {HTMLElement}
 */
function renderOutcome(quote, bookingConfirmed) {
  if (quote.outcome === "committed" && bookingConfirmed === true) {
    return el("span", { class: "outcome tone-win" }, [el("span", { class: "swatch swatch-winner" }), "Booked"]);
  }

  if (quote.outcome === "committed") {
    return el("span", { class: "outcome tone-warning" }, [
      el("span", { class: "swatch swatch-warning" }),
      "Booking not confirmed",
    ]);
  }

  if (quote.outcome === "closed") {
    return el("span", { class: "outcome tone-plain" }, [el("span", { class: "swatch swatch-refused" }), "Closed politely"]);
  }

  return el("span", { class: "outcome tone-muted" }, [el("span", { class: "swatch swatch-refused" }), "Not reached"]);
}

/**
 * @param {number} total
 * @param {number} best
 * @returns {HTMLElement}
 */
function renderPriceChip(total, best) {
  const chip = el("span", { class: "price-chip tabular" }, [formatMoney(total)]);
  chip.style.background = priceColor(total, best);
  chip.style.color = priceTextColor(total, best);
  return chip;
}

/**
 * @param {BreakdownData} data
 * @param {SummaryQuote} quote
 * @param {number} best
 * @returns {HTMLElement}
 */
function renderQuoteRow(data, quote, best) {
  const terms = describeTerms(quote, findFieldLabels(data));
  let gap = el("td", { class: "tone-win cell-strong" }, ["Best"]);
  let termsClass = "";

  if (quote.rank > 1) {
    gap = el("td", { class: "tabular" }, [formatSignedMoney(quote.total - best)]);
  }

  if (terms.hasCatch) {
    termsClass = "tone-warning";
  }

  return el("tr", {}, [
    el("td", {}, [
      el("span", { class: "name-cell" }, [
        el("span", { class: "avatar" }, [initials(quote.businessName)]),
        el("span", { class: "cell-strong" }, [quote.businessName]),
      ]),
    ]),
    el("td", {}, [renderPriceChip(quote.total, best)]),
    gap,
    el("td", { class: termsClass }, [terms.text]),
    el("td", {}, [renderOutcome(quote, data.summary.bookingConfirmed)]),
  ]);
}

/**
 * @param {BreakdownData} data
 * @param {number} shown
 * @returns {HTMLElement}
 */
function renderTableFooter(data, shown) {
  const { counts } = data.summary;
  const moreQuotes = counts.quoted - shown;
  const footer = el("div", { class: "table-footer" }, [
    el("span", { class: "legend-item" }, ["Cheaper", el("span", { class: "price-bar" }), "Pricier"]),
  ]);

  if (moreQuotes > 0) {
    footer.appendChild(el("span", {}, [pluralize(moreQuotes, "more quote", "more quotes")]));
  }

  footer.appendChild(
    el("span", { class: "legend-item" }, [
      el("span", { class: "swatch swatch-no-answer" }),
      el("strong", { class: "tabular" }, [String(counts.failed)]),
      "no answer",
    ]),
  );
  footer.appendChild(
    el("span", { class: "legend-item" }, [
      el("span", { class: "swatch swatch-never-quoted" }),
      el("strong", { class: "tabular" }, [String(counts.neverQuoted)]),
      "never quoted",
    ]),
  );
  footer.appendChild(
    el("a", { class: "table-footer-link", href: liveViewHref(data) }, [`See all ${counts.calls} calls`]),
  );
  return footer;
}

/**
 * @param {BreakdownData} data
 * @returns {HTMLElement}
 */
function renderQuotesTable(data) {
  const { summary } = data;
  const noun = findBusinessNoun(data.listing);
  const rows = summary.quotes.slice(0, TABLE_ROWS);
  let best = 0;

  if (summary.stats.best !== null) {
    best = summary.stats.best;
  }

  const body = el("tbody");

  for (const quote of rows) {
    body.appendChild(renderQuoteRow(data, quote, best));
  }

  if (rows.length === 0) {
    body.appendChild(el("tr", {}, [el("td", { colspan: 5, class: "tone-muted" }, ["No quotes came in."])]));
  }

  return el("section", { class: "card breakdown-card quotes-card" }, [
    el("div", { class: "breakdown-card-header" }, [
      el("span", { class: "section-label" }, ["BEST QUOTES"]),
      el("span", { class: "breakdown-card-note" }, [
        `Top ${rows.length} of ${summary.counts.quoted} · sorted by total`,
      ]),
    ]),
    el("table", { class: "quotes-table" }, [
      el("thead", {}, [
        el("tr", {}, [
          el("th", {}, [noun.singular.toUpperCase()]),
          el("th", {}, ["TOTAL"]),
          el("th", {}, ["VS BEST"]),
          el("th", {}, ["TERMS"]),
          el("th", {}, ["OUTCOME"]),
        ]),
      ]),
      body,
    ]),
    renderTableFooter(data, rows.length),
  ]);
}

/**
 * @param {string} label
 * @param {number} amount
 * @param {HTMLElement} bar
 * @returns {HTMLElement}
 */
function renderBarRow(label, amount, bar) {
  return el("div", { class: "price-check-row" }, [
    el("div", { class: "price-check-row-head" }, [
      el("span", {}, [label]),
      el("strong", { class: "tabular" }, [formatMoney(amount)]),
    ]),
    bar,
  ]);
}

/**
 * @param {number} pct
 * @param {string} className
 * @returns {HTMLElement}
 */
function renderBarPart(pct, className) {
  const part = el("span", { class: className });
  part.style.width = `${pct}%`;
  return part;
}

/**
 * The extra amount over the listing is striped amber, so the gap is visible at a glance.
 * @param {PriceCheckRow} row
 * @param {string} source
 * @returns {HTMLElement[]}
 */
function renderPriceBars(row, source) {
  const widest = Math.max(row.reference, row.quoted);
  const listedPct = (row.reference / widest) * 100;
  const coveredPct = (Math.min(row.quoted, row.reference) / widest) * 100;
  const extraPct = (Math.max(0, row.quoted - row.reference) / widest) * 100;

  const listedBar = el("div", { class: "price-check-bar" }, [renderBarPart(listedPct, "bar-listed")]);
  const bookedBar = el("div", { class: "price-check-bar" }, [
    renderBarPart(coveredPct, "bar-booked"),
    renderBarPart(extraPct, "bar-extra"),
  ]);

  return [
    renderBarRow(source, row.reference, listedBar),
    renderBarRow("Booked on the phone", row.quoted, bookedBar),
  ];
}

/**
 * @param {PriceCheckRow} row
 * @param {number} thresholdPct
 * @returns {HTMLElement}
 */
function describePriceCheck(row, thresholdPct) {
  const difference = row.quoted - row.reference;

  if (difference <= 0) {
    return el("p", { class: "price-check-text" }, [
      "The phone total is ",
      el("strong", { class: "tone-win" }, [formatMoney(-difference)]),
      " less than the listing.",
    ]);
  }

  let ending = ` more than the listing, within the ${thresholdPct}% limit.`;

  if (row.flagged) {
    ending = " more than the listing. A warning only, it did not stop the booking.";
  }

  return el("p", { class: "price-check-text" }, [
    "The phone total is ",
    el("strong", { class: "tone-warning" }, [formatMoney(difference)]),
    ending,
  ]);
}

/**
 * Compares the total when the job has one, and otherwise the first line the check covered.
 * @param {PriceCheckRow[]} rows
 * @returns {PriceCheckRow | undefined}
 */
function findMainRow(rows) {
  const totalRow = rows.find((row) => row.item === "Total");

  if (totalRow !== undefined) {
    return totalRow;
  }

  return rows[0];
}

/**
 * @param {RunSummary} summary
 * @returns {HTMLElement}
 */
function renderPriceCheck(summary) {
  const check = summary.priceCheck;
  const card = el("section", { class: "card breakdown-card price-check-card" });
  let note = el("span", { class: "breakdown-card-note" }, [""]);

  if (check !== null && check.flaggedCount > 0) {
    note = el("span", { class: "breakdown-card-note tone-warning" }, [`Over ${check.thresholdPct}%`]);
  } else if (check !== null) {
    note = el("span", { class: "breakdown-card-note" }, [`Within ${check.thresholdPct}%`]);
  }

  card.appendChild(el("div", { class: "breakdown-card-header" }, [el("span", { class: "section-label" }, ["PRICE CHECK"]), note]));

  const noComparison = el("p", { class: "price-check-text tone-muted" }, [
    "There was no listed price to compare against.",
  ]);

  if (check === null) {
    card.appendChild(noComparison);
    return card;
  }

  const row = findMainRow(check.rows);

  if (row === undefined) {
    card.appendChild(noComparison);
    return card;
  }

  let source = "Listed online";

  if (check.source !== undefined) {
    source = check.source;
  }

  const body = el("div", { class: "price-check-body" }, renderPriceBars(row, source));
  body.appendChild(describePriceCheck(row, check.thresholdPct));
  card.appendChild(body);
  return card;
}

/**
 * @param {BreakdownData} data
 * @param {Milestone} milestone
 * @returns {string}
 */
function describeMilestone(data, milestone) {
  const noun = findBusinessNoun(data.listing);
  const { summary } = data;

  if (milestone.key === "dialed") {
    return `Dialed ${pluralize(summary.counts.calls, noun.singular, noun.plural)}`;
  }

  if (milestone.key === "first-quote") {
    return "First quote in";
  }

  if (milestone.key === "decided") {
    return `Decided on ${pluralize(summary.counts.quoted, "quote", "quotes")}`;
  }

  if (summary.bookingConfirmed === true) {
    return "Booked";
  }

  return "Finished";
}

/**
 * @param {BreakdownData} data
 * @returns {HTMLElement}
 */
function renderTimeline(data) {
  const list = el("ol", { class: "timeline" });

  for (const milestone of data.summary.milestones) {
    const dot = el("span", { class: "timeline-dot" });
    dot.style.background = MILESTONE_COLORS[milestone.key];
    list.appendChild(
      el("li", {}, [
        dot,
        el("strong", { class: "tabular" }, [formatClock(milestone.atMs)]),
        el("span", {}, [describeMilestone(data, milestone)]),
      ]),
    );
  }

  return el("div", { class: "split-half" }, [
    el("div", { class: "breakdown-card-header" }, [el("span", { class: "section-label" }, ["TIMELINE"])]),
    list,
  ]);
}

/**
 * @param {RunSummary} summary
 * @returns {HTMLElement}
 */
function renderLandingChart(summary) {
  const bins = buildHistogram(summary.quotes.map((quote) => quote.total));
  const tallest = Math.max(1, ...bins.map((bin) => bin.count));
  const chart = el("div", { class: "landing-chart" });

  for (const bin of bins) {
    const bar = el("span", { class: "landing-bar" });
    let count = "";

    bar.style.height = `${(bin.count / tallest) * 100}%`;
    bar.style.background = bin.color;

    if (bin.count > 0) {
      count = String(bin.count);
    }

    chart.appendChild(
      el("div", { class: "landing-column" }, [
        el("div", { class: "landing-track" }, [el("span", { class: "landing-count tabular" }, [count]), bar]),
        el("span", { class: "chart-label tabular" }, [String(Math.round(bin.from))]),
      ]),
    );
  }

  return el("div", { class: "split-half" }, [
    el("div", { class: "breakdown-card-header" }, [el("span", { class: "section-label" }, ["WHERE QUOTES LANDED"])]),
    chart,
  ]);
}

/**
 * @param {HTMLElement} container
 * @param {BreakdownData} data
 */
export function renderBreakdown(container, data) {
  container.appendChild(renderTitleRow(data));
  container.appendChild(renderTiles(data));
  container.appendChild(
    el("div", { class: "breakdown-main" }, [
      renderQuotesTable(data),
      el("div", { class: "breakdown-side" }, [
        renderPriceCheck(data.summary),
        el("section", { class: "card breakdown-card split-card" }, [
          renderTimeline(data),
          renderLandingChart(data.summary),
        ]),
      ]),
    ]),
  );
}
