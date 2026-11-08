// @ts-check
import { clear, el } from "../dom.js";
import { formatClock, formatMoney, formatSignedMoney, initials } from "../format.js";
import { selectOutcomeLabel, selectTopFour } from "../state.js";
import {
  callElapsedMs,
  describeCallStatus,
  findFieldLabels,
  findKeyTerm,
} from "./view.js";

/**
 * @typedef {import("./view.js").View} View
 * @typedef {import("./view.js").KeyTerm} KeyTerm
 * @typedef {import("../state.js").RankedQuote} RankedQuote
 *
 * @typedef {{ text: string, tone: "win" | "warning" | "muted" | "plain" }} CardStatus
 * @typedef {{
 *   callId: string,
 *   name: string,
 *   initials: string,
 *   rank: string,
 *   price: string,
 *   firstPrice: string | null,
 *   saving: string | null,
 *   gap: string | null,
 *   term: KeyTerm | null,
 *   status: CardStatus,
 *   isLeader: boolean,
 *   faded: boolean,
 *   selected: boolean,
 * }} TopCardModel
 * @typedef {{ cards: TopCardModel[], finished: boolean }} TopCardsModel
 */

const SLOT_COUNT = 4;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const LEADER_LINE = "#12B76A";
const OTHER_LINE = "#6CE9A6";
const CLOSED_LINE = "#D0D5DD";

/**
 * @param {View} view
 * @param {RankedQuote} quote
 * @returns {CardStatus}
 */
function findCardStatus(view, quote) {
  const { state } = view;
  const call = state.calls[quote.callId];
  const isLeader = quote.rank === 1;

  if (state.decision !== null && isLeader) {
    const outcome = selectOutcomeLabel(state);
    let text = "Winner";
    /** @type {CardStatus["tone"]} */
    let tone = "win";

    if (outcome !== null) {
      text = outcome.text;
    }

    if (outcome !== null && outcome.tone === "warning") {
      tone = "warning";
    }

    return { text, tone };
  }

  if (state.decision !== null) {
    return { text: "Closed politely", tone: "muted" };
  }

  if (isLeader) {
    return { text: "Leading", tone: "win" };
  }

  if (call === undefined) {
    return { text: "", tone: "plain" };
  }

  const statusText = describeCallStatus(call.status).text;
  const timer = formatClock(callElapsedMs(call, view.now));
  return { text: `${statusText} ${timer}`, tone: "plain" };
}

/**
 * @param {View} view
 * @param {RankedQuote} quote
 * @returns {TopCardModel}
 */
function buildCard(view, quote) {
  const isLeader = quote.rank === 1;
  const priceCameDown = quote.firstTotal > quote.total;
  let firstPrice = null;
  let saving = null;
  let gap = null;

  if (priceCameDown) {
    firstPrice = formatMoney(quote.firstTotal);
    saving = formatSignedMoney(quote.total - quote.firstTotal);
  }

  if (isLeader === false) {
    gap = formatSignedMoney(quote.gapToLeader);
  }

  return {
    callId: quote.callId,
    name: quote.name,
    initials: initials(quote.name),
    rank: `#${quote.rank}`,
    price: formatMoney(quote.total),
    firstPrice,
    saving,
    gap,
    term: findKeyTerm(quote.fields, findFieldLabels(view)),
    status: findCardStatus(view, quote),
    isLeader,
    faded: view.state.finishedAt !== null && isLeader === false,
    selected: view.selectedCallId === quote.callId,
  };
}

/**
 * @param {View} view
 * @returns {TopCardsModel}
 */
export function selectTopCardsModel(view) {
  const cards = selectTopFour(view.state).map((quote) => buildCard(view, quote));
  return { cards, finished: view.state.finishedAt !== null };
}

/**
 * @param {TopCardModel} card
 * @returns {HTMLElement}
 */
function renderPriceLine(card) {
  const line = el("div", { class: "top-card-price-line" }, [
    el("span", { class: "top-card-price tabular" }, [card.price]),
  ]);

  if (card.firstPrice !== null && card.saving !== null) {
    line.appendChild(el("s", { class: "top-card-first tabular" }, [card.firstPrice]));
    line.appendChild(el("span", { class: "top-card-saving tabular" }, [card.saving]));
  }

  if (card.gap !== null) {
    line.appendChild(el("span", { class: "top-card-gap tabular" }, [card.gap]));
  }

  return line;
}

/**
 * @param {TopCardModel} card
 * @returns {HTMLElement}
 */
function renderBottomLine(card) {
  const status = el("span", { class: `top-card-status tone-${card.status.tone}` }, [
    card.status.text,
  ]);
  let term = null;

  if (card.term !== null) {
    let termClass = "top-card-term";

    if (card.term.isCatch) {
      termClass = "top-card-term tone-warning";
    }

    term = el("span", { class: termClass }, [card.term.text]);
  }

  if (card.isLeader) {
    return el("div", { class: "top-card-bottom" }, [status, term]);
  }

  return el("div", { class: "top-card-bottom" }, [term, status]);
}

/**
 * @param {TopCardModel} card
 * @param {(callId: string) => void} onSelect
 * @returns {HTMLElement}
 */
function renderCard(card, onSelect) {
  let className = "card top-card";

  if (card.isLeader) {
    className += " top-card-leader";
  }

  if (card.selected) {
    className += " is-selected";
  }

  if (card.faded) {
    className += " is-faded";
  }

  const button = el("button", { class: className, type: "button" }, [
    el("div", { class: "top-card-head" }, [
      el("span", { class: "avatar" }, [card.initials]),
      el("span", { class: "top-card-name" }, [card.name]),
      el("span", { class: "top-card-rank" }, [card.rank]),
    ]),
    renderPriceLine(card),
    renderBottomLine(card),
  ]);

  button.addEventListener("click", () => onSelect(card.callId));
  return button;
}

/** @returns {HTMLElement} */
function renderEmptySlot() {
  return el("div", { class: "card top-card top-card-empty" }, ["Waiting for a quote"]);
}

/**
 * @param {number} startX
 * @param {number} endX
 * @param {number} height
 * @returns {string}
 */
function buildCurve(startX, endX, height) {
  const bend = height * 0.6;
  return `M ${startX} 0 C ${startX} ${bend}, ${endX} ${height - bend}, ${endX} ${height}`;
}

/**
 * The winner keeps a solid line; once the run is over, the closed calls fade to dotted grey.
 * @param {SVGPathElement} path
 * @param {boolean} isLeader
 * @param {boolean} finished
 */
function styleConnector(path, isLeader, finished) {
  if (isLeader) {
    path.setAttribute("stroke", LEADER_LINE);
    path.setAttribute("stroke-width", "2.5");
    return;
  }

  if (finished) {
    path.setAttribute("stroke", CLOSED_LINE);
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("stroke-dasharray", "1 4");
    path.setAttribute("stroke-linecap", "round");
    return;
  }

  path.setAttribute("stroke", OTHER_LINE);
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("stroke-dasharray", "4 4");
}

/**
 * @param {SVGSVGElement} svg
 * @param {HTMLElement} row
 * @param {number} cardCount
 * @param {boolean} finished
 */
function drawConnectors(svg, row, cardCount, finished) {
  clear(svg);

  const width = svg.clientWidth;
  const height = svg.clientHeight;
  const slots = Array.from(row.children);
  const rowLeft = row.getBoundingClientRect().left;
  const startX = width / 2;

  for (let index = 0; index < cardCount; index += 1) {
    const slot = slots[index];

    if (slot === undefined) {
      continue;
    }

    const box = slot.getBoundingClientRect();
    const endX = box.left - rowLeft + box.width / 2;
    const path = document.createElementNS(SVG_NAMESPACE, "path");

    path.setAttribute("d", buildCurve(startX, endX, height));
    path.setAttribute("fill", "none");
    styleConnector(path, index === 0, finished);
    svg.appendChild(path);
  }
}

/**
 * @param {HTMLElement} container
 * @param {(callId: string) => void} onSelect
 */
export function createTopCards(container, onSelect) {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  const row = el("div", { class: "top-cards" });
  let cardCount = 0;
  let finished = false;

  svg.setAttribute("class", "connectors");
  svg.setAttribute("aria-hidden", "true");
  container.appendChild(svg);
  container.appendChild(row);

  // Card positions follow the page width, so the lines are redrawn when it changes.
  const resizeObserver = new ResizeObserver(() => drawConnectors(svg, row, cardCount, finished));
  resizeObserver.observe(row);

  /** @param {TopCardsModel} model */
  function update(model) {
    clear(row);
    cardCount = model.cards.length;
    finished = model.finished;

    for (let index = 0; index < SLOT_COUNT; index += 1) {
      const card = model.cards[index];

      if (card === undefined) {
        row.appendChild(renderEmptySlot());
      } else {
        row.appendChild(renderCard(card, onSelect));
      }
    }

    drawConnectors(svg, row, cardCount, finished);
  }

  return { update };
}
