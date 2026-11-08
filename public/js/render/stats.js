// @ts-check
import { clear, el, icon } from "../dom.js";
import { formatMoney, formatSignedPercent, pluralize } from "../format.js";
import { buildHistogram } from "../price.js";
import { selectRanking, selectStats } from "../state.js";

/**
 * @typedef {import("./view.js").View} View
 *
 * @typedef {{ heightPct: number, color: string, label: string }} BarModel
 * @typedef {{ label: string, value: string, tone: "win" | "warning" | "plain" | "muted" }} StatModel
 * @typedef {{ chartTitle: string, bars: BarModel[], stats: StatModel[] }} StatsModel
 */

const EMPTY_VALUE = "—";
const MIN_BAR_PCT = 4;

/**
 * @param {number[]} totals
 * @returns {BarModel[]}
 */
function buildBars(totals) {
  const bins = buildHistogram(totals);
  const tallest = Math.max(1, ...bins.map((bin) => bin.count));

  return bins.map((bin) => {
    // Empty bins keep a sliver so the scale still reads left to right.
    const heightPct = Math.max(MIN_BAR_PCT, Math.round((bin.count / tallest) * 100));
    return { heightPct, color: bin.color, label: String(Math.round(bin.from)) };
  });
}

/**
 * @param {number | null} amount
 * @returns {string}
 */
function moneyOrEmpty(amount) {
  if (amount === null) {
    return EMPTY_VALUE;
  }

  return formatMoney(amount);
}

/**
 * Paying more than the listed price is a warning; paying less is a win.
 * @param {View} view
 * @param {number | null} vsReferencePct
 * @returns {StatModel | null}
 */
function buildReferenceStat(view, vsReferencePct) {
  const job = view.state.job;

  if (job === null || job.reference === undefined || job.reference.total === undefined) {
    return null;
  }

  const label = `vs listed online ${formatMoney(job.reference.total)}`;

  if (vsReferencePct === null) {
    return { label, value: EMPTY_VALUE, tone: "plain" };
  }

  /** @type {StatModel["tone"]} */
  let tone = "win";

  if (vsReferencePct > 0) {
    tone = "warning";
  }

  return { label, value: formatSignedPercent(vsReferencePct), tone };
}

/**
 * @param {View} view
 * @returns {StatsModel}
 */
export function selectStatsModel(view) {
  const stats = selectStats(view.state);
  const totals = selectRanking(view.state).map((quote) => quote.total);

  /** @type {StatModel[]} */
  const cards = [
    { label: "Best so far", value: moneyOrEmpty(stats.best), tone: "win" },
    { label: "Median quote", value: moneyOrEmpty(stats.median), tone: "plain" },
    { label: "Saved vs median", value: moneyOrEmpty(stats.savedVsMedian), tone: "win" },
  ];
  const referenceStat = buildReferenceStat(view, stats.vsReferencePct);

  if (referenceStat !== null) {
    cards.push(referenceStat);
  }

  return {
    chartTitle: `Where the ${pluralize(stats.quoteCount, "quote lands", "quotes land")}`,
    bars: buildBars(totals),
    stats: cards,
  };
}

/**
 * @param {BarModel[]} bars
 * @returns {HTMLElement}
 */
function renderChart(bars) {
  const columns = el("div", { class: "chart-bars" });

  for (const bar of bars) {
    const fill = el("span", { class: "chart-bar" });
    fill.style.height = `${bar.heightPct}%`;
    fill.style.background = bar.color;
    columns.appendChild(
      el("div", { class: "chart-column" }, [
        el("div", { class: "chart-bar-track" }, [fill]),
        el("span", { class: "chart-label tabular" }, [bar.label]),
      ]),
    );
  }

  return columns;
}

/**
 * Nothing to show yet reads as grey, not as a green or amber result.
 * @param {StatModel} stat
 * @returns {HTMLElement}
 */
function renderStat(stat) {
  let tone = stat.tone;

  if (stat.value === EMPTY_VALUE) {
    tone = "muted";
  }

  return el("div", { class: "card stat-card" }, [
    el("span", { class: "stat-label" }, [stat.label]),
    el("span", { class: `stat-value tabular tone-${tone}` }, [stat.value]),
  ]);
}

/**
 * @param {HTMLElement} row
 */
export function createStats(row) {
  /** @param {StatsModel} model */
  function update(model) {
    clear(row);

    const chart = el("div", { class: "card stat-card chart-card" }, [
      el("span", { class: "stat-label chart-title" }, [
        icon("chart-column", 14),
        model.chartTitle,
      ]),
      renderChart(model.bars),
    ]);

    row.appendChild(chart);

    for (const stat of model.stats) {
      row.appendChild(renderStat(stat));
    }
  }

  return { update };
}
