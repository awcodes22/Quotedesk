// @ts-check
import { clear, el, icon } from "../dom.js";
import { formatClock, formatMoney, formatSignedPercent } from "../format.js";
import {
  isLiveProvider,
  selectOutcomeLabel,
  selectRanking,
  selectStats,
  showsPriceComparisons,
} from "../state.js";
import { findBusinessNoun, findFieldLabels, findKeyTerm, runElapsedMs } from "./view.js";

/**
 * @typedef {import("./view.js").View} View
 * @typedef {import("../state.js").RankedQuote} RankedQuote
 *
 * @typedef {{ text: string, bold: boolean }} SentencePart
 * @typedef {{ label: string, value: string, tone: "win" | "warning" }} BarStat
 * @typedef {{
 *   title: string,
 *   confirmed: boolean,
 *   sentence: SentencePart[],
 *   stats: BarStat[],
 *   breakdownHref: string,
 * }} CompletedBarModel
 */

/**
 * @param {View} view
 * @param {RankedQuote} winner
 * @returns {SentencePart[]}
 */
function describeConfirmedBooking(view, winner) {
  const term = findKeyTerm(winner.fields, findFieldLabels(view));
  const job = view.state.job;
  let termText = "";
  let confirmation = "";

  if (term !== null) {
    termText = `, ${term.text.toLowerCase()}`;
  }

  if (job !== null && job.contact !== undefined) {
    confirmation = ` Confirmation to ${job.contact.email}.`;
  }

  return [
    { text: `Quoted ${winner.name} at `, bold: false },
    { text: formatMoney(winner.total), bold: true },
    { text: `${termText}.${confirmation}`, bold: false },
  ];
}

/**
 * Live calls never book, so the sentence recommends instead of confirming.
 * @param {View} view
 * @param {RankedQuote} winner
 * @returns {SentencePart[]}
 */
function describeBestQuote(view, winner) {
  const term = findKeyTerm(winner.fields, findFieldLabels(view));
  let termText = "";

  if (term !== null) {
    termText = `, ${term.text.toLowerCase()}`;
  }

  return [
    { text: `Best quote: ${winner.name} at `, bold: false },
    { text: formatMoney(winner.total), bold: true },
    { text: `${termText}.`, bold: false },
  ];
}

/**
 * @param {View} view
 * @returns {SentencePart[]}
 */
function buildSentence(view) {
  const winner = selectRanking(view.state)[0];
  const outcome = selectOutcomeLabel(view.state);
  const noun = findBusinessNoun(view.listing);

  if (winner === undefined) {
    return [{ text: "No quotes came in.", bold: false }];
  }

  if (isLiveProvider(view.state.provider)) {
    return describeBestQuote(view, winner);
  }

  if (outcome !== null && outcome.tone === "success") {
    return describeConfirmedBooking(view, winner);
  }

  return [
    { text: `The booking with ${winner.name} at `, bold: false },
    { text: formatMoney(winner.total), bold: true },
    { text: ` was not confirmed. Check with the ${noun.singular}.`, bold: false },
  ];
}

/**
 * @param {View} view
 * @returns {number | null}
 */
function findReferenceTotal(view) {
  const job = view.state.job;

  if (job === null || job.reference === undefined || job.reference.total === undefined) {
    return null;
  }

  return job.reference.total;
}

/**
 * @param {View} view
 * @returns {BarStat[]}
 */
function buildStats(view) {
  const stats = selectStats(view.state);
  const referenceTotal = findReferenceTotal(view);
  /** @type {BarStat[]} */
  const items = [];

  if (showsPriceComparisons(view.state) === false) {
    return items;
  }

  if (stats.savedVsMedian !== null) {
    items.push({ label: "Saved vs median", value: formatMoney(stats.savedVsMedian), tone: "win" });
  }

  if (referenceTotal !== null && stats.vsReferencePct !== null) {
    /** @type {BarStat["tone"]} */
    let tone = "win";

    if (stats.vsReferencePct > 0) {
      tone = "warning";
    }

    items.push({
      label: `vs online ${formatMoney(referenceTotal)}`,
      value: formatSignedPercent(stats.vsReferencePct),
      tone,
    });
  }

  return items;
}

/**
 * @param {View} view
 * @returns {CompletedBarModel}
 */
export function selectCompletedBarModel(view) {
  const outcome = selectOutcomeLabel(view.state);
  let runId = "";

  if (view.state.runId !== null) {
    runId = view.state.runId;
  }

  return {
    title: `Run completed in ${formatClock(runElapsedMs(view))}`,
    confirmed: outcome !== null && outcome.tone === "success",
    sentence: buildSentence(view),
    stats: buildStats(view),
    breakdownHref: `/runs/${encodeURIComponent(runId)}/breakdown`,
  };
}

/**
 * @param {SentencePart[]} parts
 * @returns {HTMLElement}
 */
function renderSentence(parts) {
  const sentence = el("p", { class: "completed-sentence" });

  for (const part of parts) {
    if (part.bold) {
      sentence.appendChild(el("strong", {}, [part.text]));
    } else {
      sentence.appendChild(document.createTextNode(part.text));
    }
  }

  return sentence;
}

/**
 * @param {BarStat} stat
 * @returns {HTMLElement}
 */
function renderStat(stat) {
  return el("div", { class: "completed-stat" }, [
    el("span", { class: "completed-stat-label" }, [stat.label]),
    el("span", { class: `completed-stat-value tabular tone-${stat.tone}` }, [stat.value]),
  ]);
}

/**
 * @param {boolean} confirmed
 * @returns {HTMLElement}
 */
function renderBarIcon(confirmed) {
  if (confirmed) {
    return el("span", { class: "icon-square icon-square-lg" }, [icon("check", 22, "var(--win)")]);
  }

  return el("span", { class: "icon-square icon-square-lg" }, [icon("phone-off", 22, "var(--warning)")]);
}

/**
 * @param {HTMLElement} card
 */
export function createCompletedBar(card) {
  /** @param {CompletedBarModel} model */
  function update(model) {
    clear(card);
    card.appendChild(renderBarIcon(model.confirmed));
    card.appendChild(
      el("div", { class: "completed-text" }, [
        el("span", { class: "completed-title tabular" }, [model.title]),
        renderSentence(model.sentence),
      ]),
    );

    for (const stat of model.stats) {
      card.appendChild(renderStat(stat));
    }

    card.appendChild(
      el("a", { class: "button button-primary button-large", href: model.breakdownHref }, [
        "View breakdown",
        icon("arrow-right", 16),
      ]),
    );
  }

  return { update };
}
