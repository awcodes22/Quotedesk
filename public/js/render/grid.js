// @ts-check
import { clear, el, icon } from "../dom.js";
import { formatClock } from "../format.js";
import { priceColor } from "../price.js";
import { callElapsedMs, isLiveRun } from "./view.js";
import {
  GRID_STATES,
  selectCalls,
  selectGridCounts,
  selectGridState,
  selectStats,
  selectTopFour,
} from "../state.js";

/**
 * @typedef {import("./view.js").View} View
 * @typedef {import("./view.js").GridFilter} GridFilter
 * @typedef {import("./view.js").GridSort} GridSort
 * @typedef {import("../state.js").GridState} GridState
 * @typedef {import("../state.js").CallState} CallState
 * @typedef {import("../icons.js").IconName} IconName
 *
 * @typedef {GridState | "top"} SquareKind
 * @typedef {{ key: GridFilter, label: string, count: number, active: boolean }} ChipModel
 * @typedef {{
 *   callId: string,
 *   name: string,
 *   kind: SquareKind,
 *   price: string | null,
 *   priceCameDown: boolean,
 *   timer: string | null,
 *   color: string | null,
 *   selected: boolean,
 *   dim: boolean,
 * }} SquareModel
 * @typedef {{ chips: ChipModel[], squares: SquareModel[], finished: boolean, winnerLabel: string }} GridModel
 *
 * @typedef {{
 *   onSelect: (callId: string) => void,
 *   onFilter: (filter: GridFilter) => void,
 *   onSearch: (text: string) => void,
 *   onSort: (sort: GridSort) => void,
 * }} GridActions
 */

/** @type {Record<GridState, string>} */
const CHIP_LABELS = {
  winner: "Winner",
  quoted: "Quoted",
  talking: "Talking",
  dialing: "Dialing",
  queued: "Queued",
  "no-answer": "No answer",
  refused: "Refused",
  closed: "Quoted, closed politely",
  "never-quoted": "Never quoted",
};

/** @type {Partial<Record<SquareKind, IconName>>} */
const SQUARE_ICONS = {
  talking: "audio-lines",
  dialing: "phone-call",
  queued: "clock",
  "no-answer": "phone-missed",
  refused: "ban",
  // A plain handset: someone picked up and talked, there just wasn't a price.
  "never-quoted": "phone",
};

// Live calls are real phone calls that never book and hang up on their own.
/** @type {Partial<Record<GridState, string>>} */
const LIVE_CHIP_LABELS = {
  winner: "Best quote",
  talking: "On call",
  closed: "Quoted",
};

/**
 * @param {View} view
 * @param {GridState} gridState
 * @returns {string}
 */
function chipLabel(view, gridState) {
  const liveLabel = LIVE_CHIP_LABELS[gridState];

  if (isLiveRun(view) && liveLabel !== undefined) {
    return liveLabel;
  }

  return CHIP_LABELS[gridState];
}

/**
 * @param {View} view
 * @returns {ChipModel[]}
 */
function buildChips(view) {
  const counts = selectGridCounts(view.state);
  const total = view.state.callOrder.length;

  /** @type {ChipModel[]} */
  const chips = [{ key: "all", label: "All", count: total, active: view.filter === "all" }];

  for (const gridState of GRID_STATES) {
    const count = counts[gridState];

    if (count > 0) {
      chips.push({
        key: gridState,
        label: chipLabel(view, gridState),
        count,
        active: view.filter === gridState,
      });
    }
  }

  return chips;
}

/**
 * @param {View} view
 * @param {CallState} call
 * @param {GridState} gridState
 * @returns {boolean}
 */
function isDimmed(view, call, gridState) {
  const search = view.search.trim().toLowerCase();
  const matchesSearch = search === "" || call.name.toLowerCase().includes(search);
  const matchesFilter = view.filter === "all" || view.filter === gridState;
  return matchesSearch === false || matchesFilter === false;
}

/**
 * A live call can run for minutes before its quote lands, so its square shows how long it has been on.
 * @param {View} view
 * @param {CallState} call
 * @param {GridState} gridState
 * @returns {string | null}
 */
function findSquareTimer(view, call, gridState) {
  const onTheLine = gridState === "talking" || gridState === "dialing";

  if (isLiveRun(view) === false || onTheLine === false) {
    return null;
  }

  return formatClock(callElapsedMs(call, view.now));
}

/**
 * @param {View} view
 * @param {CallState} call
 * @param {Set<string>} topCallIds
 * @param {number | null} best
 * @returns {SquareModel}
 */
function buildSquare(view, call, topCallIds, best) {
  const gridState = selectGridState(view.state, call);
  /** @type {SquareKind} */
  let kind = gridState;
  let price = null;
  let color = null;
  let priceCameDown = false;

  if (gridState === "quoted" && topCallIds.has(call.callId)) {
    kind = "top";
  }

  if (call.quote !== null && call.firstQuote !== null) {
    price = String(call.quote.total);
    priceCameDown = call.quote.total < call.firstQuote.total;
  }

  if (call.quote !== null && best !== null) {
    color = priceColor(call.quote.total, best);
  }

  return {
    callId: call.callId,
    name: call.name,
    kind,
    price,
    priceCameDown,
    timer: findSquareTimer(view, call, gridState),
    color,
    selected: view.selectedCallId === call.callId,
    dim: isDimmed(view, call, gridState),
  };
}

/**
 * Quoted calls come first, cheapest first. Everyone else keeps the order they were dialed in.
 * @param {CallState[]} calls
 * @returns {CallState[]}
 */
function sortByPrice(calls) {
  const quoted = calls.filter((call) => call.quote !== null);
  const unquoted = calls.filter((call) => call.quote === null);

  quoted.sort((a, b) => {
    let aTotal = 0;
    let bTotal = 0;

    if (a.quote !== null) {
      aTotal = a.quote.total;
    }

    if (b.quote !== null) {
      bTotal = b.quote.total;
    }

    return aTotal - bTotal;
  });

  return [...quoted, ...unquoted];
}

/**
 * @param {View} view
 * @returns {GridModel}
 */
export function selectGridModel(view) {
  const topCallIds = new Set(selectTopFour(view.state).map((quote) => quote.callId));
  const best = selectStats(view.state).best;
  let calls = selectCalls(view.state);

  if (view.sort === "price") {
    calls = sortByPrice(calls);
  }

  const squares = calls.map((call) => buildSquare(view, call, topCallIds, best));

  return {
    chips: buildChips(view),
    squares,
    finished: view.state.finishedAt !== null,
    winnerLabel: chipLabel(view, "winner"),
  };
}

/**
 * @param {ChipModel} chip
 * @param {(filter: GridFilter) => void} onFilter
 * @returns {HTMLElement}
 */
function renderChip(chip, onFilter) {
  let className = "chip";
  let swatch = null;

  if (chip.active) {
    className += " is-active";
  }

  if (chip.key !== "all") {
    swatch = el("span", { class: `swatch swatch-${chip.key}` });
  }

  const button = el("button", { class: className, type: "button" }, [
    swatch,
    el("span", {}, [chip.label]),
    el("strong", { class: "tabular" }, [String(chip.count)]),
  ]);

  // A second click on the active chip goes back to showing everything.
  button.addEventListener("click", () => {
    if (chip.active) {
      onFilter("all");
    } else {
      onFilter(chip.key);
    }
  });

  return button;
}

/**
 * @param {SquareModel} square
 * @returns {Element | null}
 */
function renderSquareIcon(square) {
  if (square.kind === "top") {
    return icon("star", 12);
  }

  if (square.kind === "winner") {
    return icon("check", 12);
  }

  if (square.kind === "quoted" && square.priceCameDown) {
    return icon("arrow-down", 12);
  }

  if (square.kind === "quoted") {
    return icon("tag", 12);
  }

  const iconName = SQUARE_ICONS[square.kind];

  if (iconName === undefined) {
    return null;
  }

  return icon(iconName, 14);
}

/**
 * @param {HTMLButtonElement} button
 * @param {SquareModel} square
 */
function paintSquare(button, square) {
  let className = `square square-${square.kind}`;

  if (square.selected) {
    className += " is-selected";
  }

  if (square.dim) {
    className += " is-dim";
  }

  button.className = className;
  button.title = square.name;
  button.setAttribute("aria-label", square.name);
  button.style.background = "";

  // Only plain and closed quotes take the price scale; top 4 and the winner stay solid green.
  if (square.color !== null && (square.kind === "quoted" || square.kind === "closed")) {
    button.style.background = square.color;
  }

  clear(button);
  const squareIcon = renderSquareIcon(square);

  if (squareIcon !== null) {
    button.appendChild(squareIcon);
  }

  if (square.price !== null) {
    button.appendChild(el("span", { class: "tabular" }, [square.price]));
  }

  if (square.timer !== null) {
    button.appendChild(el("span", { class: "tabular" }, [square.timer]));
  }
}

/** @returns {HTMLElement} */
function renderLegend() {
  return el("div", { class: "grid-legend" }, [
    el("span", { class: "legend-item" }, [el("span", { class: "swatch swatch-top" }), "Top 4"]),
    el("span", { class: "legend-item" }, [icon("arrow-down", 14), "Price came down"]),
    el("span", { class: "legend-item" }, [
      "Cheaper",
      el("span", { class: "price-bar" }),
      "Pricier",
    ]),
  ]);
}

/**
 * @param {HTMLElement} winnerLabel
 * @returns {HTMLElement}
 */
function renderFinishedBar(winnerLabel) {
  return el("div", { class: "grid-bar" }, [
    el("div", { class: "grid-legend" }, [
      el("span", { class: "legend-item" }, [el("span", { class: "swatch swatch-winner" }), winnerLabel]),
      el("span", { class: "legend-item" }, [
        "Cheaper",
        el("span", { class: "price-bar" }),
        "Pricier",
      ]),
      el("span", { class: "legend-item" }, ["Every line is closed"]),
    ]),
    el("span", { class: "grid-hint" }, ["Click any square to read its call"]),
  ]);
}

/**
 * @param {GridActions} actions
 * @returns {HTMLElement}
 */
function renderTools(actions) {
  const search = el("input", {
    class: "search-input",
    type: "search",
    placeholder: "Find a call",
    "aria-label": "Find a call",
  });
  const sort = el("select", { class: "sort-select", "aria-label": "Sort" }, [
    el("option", { value: "price" }, ["Sort: price"]),
    el("option", { value: "order" }, ["Sort: call order"]),
  ]);

  search.addEventListener("input", () => actions.onSearch(search.value));
  sort.addEventListener("change", () => {
    if (sort.value === "order") {
      actions.onSort("order");
    } else {
      actions.onSort("price");
    }
  });

  return el("div", { class: "grid-tools" }, [
    el("label", { class: "search" }, [icon("search", 14), search]),
    sort,
  ]);
}

/**
 * @param {HTMLElement} card
 * @param {GridActions} actions
 */
export function createGrid(card, actions) {
  const chips = el("div", { class: "chips" });
  const squares = el("div", { class: "squares" });
  /** @type {Map<string, { button: HTMLButtonElement, key: string }>} */
  const squareNodes = new Map();
  let lastOrder = "";
  let lastChips = "";

  const liveBar = el("div", { class: "grid-bar" }, [renderLegend(), renderTools(actions)]);
  const winnerLabel = el("span", {}, [CHIP_LABELS.winner]);
  const finishedBar = renderFinishedBar(winnerLabel);

  finishedBar.hidden = true;
  card.appendChild(chips);
  card.appendChild(liveBar);
  card.appendChild(finishedBar);
  card.appendChild(squares);

  /** @param {ChipModel[]} chipModels */
  function updateChips(chipModels) {
    const key = JSON.stringify(chipModels);

    if (key === lastChips) {
      return;
    }

    lastChips = key;
    clear(chips);

    for (const chip of chipModels) {
      chips.appendChild(renderChip(chip, actions.onFilter));
    }
  }

  /** @param {SquareModel} square */
  function findOrCreateSquare(square) {
    const existing = squareNodes.get(square.callId);

    if (existing !== undefined) {
      return existing;
    }

    const button = el("button", { type: "button" });
    button.addEventListener("click", () => actions.onSelect(square.callId));

    const node = { button, key: "" };
    squareNodes.set(square.callId, node);
    return node;
  }

  // Each square repaints only when its own data changed, which keeps big runs cheap.
  /** @param {SquareModel[]} squareModels */
  function updateSquares(squareModels) {
    for (const square of squareModels) {
      const node = findOrCreateSquare(square);
      const key = JSON.stringify(square);

      if (key !== node.key) {
        node.key = key;
        paintSquare(node.button, square);
      }
    }

    const order = squareModels.map((square) => square.callId).join(",");

    if (order === lastOrder) {
      return;
    }

    lastOrder = order;

    for (const square of squareModels) {
      const node = squareNodes.get(square.callId);

      if (node !== undefined) {
        squares.appendChild(node.button);
      }
    }
  }

  /** @param {GridModel} model */
  function update(model) {
    liveBar.hidden = model.finished;
    finishedBar.hidden = model.finished === false;
    winnerLabel.textContent = model.winnerLabel;
    updateChips(model.chips);
    updateSquares(model.squares);
  }

  return { update };
}
