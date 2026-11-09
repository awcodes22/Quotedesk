// @ts-check
import { clear, el } from "../dom.js";
import { formatClock, formatMoney, formatSignedMoney, initials } from "../format.js";
import {
  endedWithoutPrice,
  isNoAnswer,
  selectCalls,
  selectOutcomeLabel,
  selectTopFour,
} from "../state.js";
import {
  callElapsedMs,
  describeCallStatus,
  findFieldLabels,
  findKeyTerm,
  isLiveRun,
} from "./view.js";

/**
 * @typedef {import("./view.js").View} View
 * @typedef {import("./view.js").KeyTerm} KeyTerm
 * @typedef {import("../state.js").RankedQuote} RankedQuote
 * @typedef {import("../state.js").CallState} CallState
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
 *   notes: string[],
 * }} TopCardModel
 * @typedef {{
 *   callId: string,
 *   name: string,
 *   initials: string,
 *   status: string,
 *   selected: boolean,
 *   notes: string[],
 * }} PendingCardModel
 * @typedef {{
 *   cards: TopCardModel[],
 *   pending: PendingCardModel[],
 *   slotCount: number,
 *   finished: boolean,
 * }} TopCardsModel
 */

const SLOT_COUNT = 4;
// Matches the row's 12px gap, so a short row keeps the same card width as a full one.
const SLOT_WIDTH = "calc((100% - 36px) / 4)";
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

  // Live calls hang up on their own, so nobody was closed by the head agent.
  if (state.decision !== null && isLiveRun(view)) {
    return { text: "Quoted", tone: "muted" };
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

  const statusText = describeCallStatus(call.status, isLiveRun(view)).text;
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
    selected: showsSelection(view, quote.callId),
    notes: findNotes(view, quote.callId),
  };
}

/**
 * With one call there is nothing to choose between, and a selection ring would read as a highlight.
 * @param {View} view
 * @param {string} callId
 * @returns {boolean}
 */
function showsSelection(view, callId) {
  return view.state.callOrder.length > 1 && view.selectedCallId === callId;
}

/**
 * @param {View} view
 * @param {string} callId
 * @returns {string[]}
 */
function findNotes(view, callId) {
  const call = view.state.calls[callId];

  if (call === undefined) {
    return [];
  }

  return call.notes;
}

/**
 * @param {View} view
 * @param {CallState} call
 * @returns {string}
 */
function describePendingCall(view, call) {
  if (isNoAnswer(call)) {
    return "No answer";
  }

  if (endedWithoutPrice(call)) {
    return "Ended without a price";
  }

  const statusText = describeCallStatus(call.status, isLiveRun(view)).text;

  if (call.dialedAt === null || call.endedAt !== null) {
    return statusText;
  }

  return `${statusText} ${formatClock(callElapsedMs(call, view.now))}`;
}

/**
 * @param {View} view
 * @param {CallState} call
 * @returns {PendingCardModel}
 */
function buildPendingCard(view, call) {
  return {
    callId: call.callId,
    name: call.name,
    initials: initials(call.name),
    status: describePendingCall(view, call),
    selected: showsSelection(view, call.callId),
    notes: call.notes,
  };
}

/**
 * With no more calls than slots, every call gets its own card, quoted or not, and no slot sits empty.
 * @param {View} view
 * @returns {TopCardsModel}
 */
export function selectTopCardsModel(view) {
  const cards = selectTopFour(view.state).map((quote) => buildCard(view, quote));
  const callCount = view.state.callOrder.length;
  const slotCount = Math.min(SLOT_COUNT, callCount);
  /** @type {PendingCardModel[]} */
  let pending = [];

  if (callCount <= SLOT_COUNT) {
    const unquoted = selectCalls(view.state).filter((call) => call.quote === null);
    pending = unquoted.map((call) => buildPendingCard(view, call));
  }

  return { cards, pending, slotCount, finished: view.state.finishedAt !== null };
}

/**
 * @param {string[]} notes
 * @returns {HTMLElement | null}
 */
function renderNotesLine(notes) {
  if (notes.length === 0) {
    return null;
  }

  const text = notes.join(" · ");
  return el("div", { class: "top-card-notes", title: text }, [text]);
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
    renderNotesLine(card.notes),
    renderBottomLine(card),
  ]);

  button.addEventListener("click", () => onSelect(card.callId));
  return button;
}

/**
 * A call that hasn't quoted yet, shown when the run has fewer calls than slots.
 * @param {PendingCardModel} card
 * @param {(callId: string) => void} onSelect
 * @returns {HTMLElement}
 */
function renderPendingCard(card, onSelect) {
  let className = "card top-card top-card-pending";

  if (card.selected) {
    className += " is-selected";
  }

  const button = el("button", { class: className, type: "button" }, [
    el("div", { class: "top-card-head" }, [
      el("span", { class: "avatar" }, [card.initials]),
      el("span", { class: "top-card-name" }, [card.name]),
    ]),
    renderNotesLine(card.notes),
    el("div", { class: "top-card-bottom" }, [
      el("span", { class: "top-card-status tone-plain" }, [card.status]),
    ]),
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
    cardCount = model.cards.length + model.pending.length;
    finished = model.finished;
    row.style.gridTemplateColumns = "";

    // A short row keeps full-size cards and sits centred under the head agent.
    if (model.slotCount < SLOT_COUNT) {
      row.style.gridTemplateColumns = `repeat(${model.slotCount}, ${SLOT_WIDTH})`;
    }

    for (let index = 0; index < model.slotCount; index += 1) {
      const card = model.cards[index];
      const pending = model.pending[index - model.cards.length];

      if (card !== undefined) {
        row.appendChild(renderCard(card, onSelect));
      } else if (pending !== undefined) {
        row.appendChild(renderPendingCard(pending, onSelect));
      } else {
        row.appendChild(renderEmptySlot());
      }
    }

    drawConnectors(svg, row, cardCount, finished);
  }

  return { update };
}
