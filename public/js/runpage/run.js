// @ts-check
import { clear, el, icon } from "../dom.js";
import { formatClock, formatMoney } from "../format.js";
import { formatPublicPhone } from "../phone.js";
import { createInitialState, isSelfTestCall, isSelfTestRun, selectCalls, selectRanking } from "../state.js";
import { followRun } from "../stream.js";
import {
  buildTile,
  classifyCall,
  describeNoQuotes,
  describeQuoteTiles,
  describeTerms,
  LIVE_STATUSES,
  readBreakfast,
  selectBest,
  selectDoneStats,
  selectHeadAgent,
  selectNights,
  selectPhase,
  selectProgress,
  selectRunnersUp,
  selectStatusCounts,
  selectStayPills,
  selectTestSteps,
  selectTileSize,
  selectTopThree,
} from "./model.js";

/**
 * @typedef {import("../state.js").RunState} RunState
 * @typedef {import("../state.js").CallState} CallState
 * @typedef {import("../state.js").RankedQuote} RankedQuote
 * @typedef {import("./model.js").CallKind} CallKind
 * @typedef {import("./model.js").TileModel} TileModel
 * @typedef {import("../icons.js").IconName} IconName
 */

const TICK_MS = 500;
const RUN_PATH = /^\/run\/(run-[A-Za-z0-9-]+)\/?$/;

/** @type {Record<CallKind, string>} */
const KIND_COLORS = {
  talking: "#2563EB",
  hold: "#D97706",
  menu: "#7C3AED",
  ringing: "#6B7280",
  quoted: "#12B76A",
  "no-answer": "#DC2626",
  "no-quote": "#9CA3AF",
};

/** @type {Record<CallKind, string>} */
const KIND_LABELS = {
  talking: "Talking",
  hold: "On hold",
  menu: "Phone menu",
  ringing: "Ringing",
  quoted: "Quoted",
  "no-answer": "No answer",
  "no-quote": "No quote",
};

/** @type {Record<string, string>} */
const BRIEF_LABELS = {
  request: "Request",
  dates: "Dates",
  ask_about: "Asks about",
  guest_name: "Guest name",
  call_mode: "Call mode",
};

const page = {
  runId: "",
  state: createInitialState(),
  ended: false,
  /** @type {string | null} */
  pickedCallId: null,
  // The smallest gap between an event's time and its arrival is the best guess at the server's clock.
  clockOffsetMs: Number.POSITIVE_INFINITY,
  stopping: false,
  transcriptOpen: false,
};

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function findElement(id) {
  const element = document.getElementById(id);

  if (element === null) {
    throw new Error(`The page is missing #${id}.`);
  }

  return element;
}

function now() {
  if (Number.isFinite(page.clockOffsetMs) === false) {
    return Date.now();
  }

  return Date.now() - page.clockOffsetMs;
}

function elapsedMs() {
  const { startedAt, finishedAt } = page.state;

  if (startedAt === null) {
    return 0;
  }

  if (finishedAt !== null) {
    return finishedAt - startedAt;
  }

  return Math.max(0, now() - startedAt);
}

/**
 * A region redraws only when the model it shows has changed, so ticking timers stay cheap.
 * @template Model
 * @param {HTMLElement} container
 * @param {() => Model} select
 * @param {(container: HTMLElement, model: Model) => void} draw
 * @returns {() => void}
 */
function region(container, select, draw) {
  let lastKey = "";

  return () => {
    const model = select();
    const key = JSON.stringify(model);

    if (key === lastKey) {
      return;
    }

    lastKey = key;
    clear(container);
    draw(container, model);
  };
}

/**
 * @param {number} count
 * @param {string} singular
 * @param {string} plural
 * @returns {string}
 */
function countLabel(count, singular, plural) {
  if (count === 1) {
    return `1 ${singular}`;
  }

  return `${count} ${plural}`;
}

function businessNouns() {
  const job = page.state.job;

  if (job !== null && job.industryId !== "hotels") {
    return { singular: "business", plural: "businesses" };
  }

  return { singular: "hotel", plural: "hotels" };
}

// ---------- Selection ----------

/** @returns {CallState | null} */
function findSelectedCall() {
  const calls = selectCalls(page.state);
  const picked = calls.find((call) => call.callId === page.pickedCallId);

  if (picked !== undefined) {
    return picked;
  }

  const ranking = selectRanking(page.state);
  const winner = ranking[0];

  if (page.state.finishedAt !== null && winner !== undefined) {
    const winnerCall = calls.find((call) => call.callId === winner.callId);

    if (winnerCall !== undefined) {
      return winnerCall;
    }
  }

  const talking = calls.find((call) => classifyCall(call) === "talking");

  if (talking !== undefined) {
    return talking;
  }

  const first = calls[0];

  if (first === undefined) {
    return null;
  }

  return first;
}

/**
 * @param {string} callId
 */
function pickCall(callId) {
  page.pickedCallId = callId;
  page.transcriptOpen = false;
  render();
}

// ---------- Sidebar ----------

function selectSide() {
  const phase = selectPhase(page.state);
  let eyebrow = "Live quote";

  if (phase === "test") {
    eyebrow = "Test call";
  }

  if (phase === "done") {
    eyebrow = "Quote done";
  }

  return {
    eyebrow,
    done: phase === "done",
    progress: selectProgress(page.state),
    counts: selectStatusCounts(page.state),
  };
}

/**
 * @param {HTMLElement} side
 * @param {ReturnType<typeof selectSide>} model
 */
function drawSide(side, model) {
  const fill = el("div", { class: "rp-bar-fill" });
  fill.style.width = `${model.progress.pct}%`;

  if (model.done) {
    fill.classList.add("is-done");
  }

  const counts = model.counts.map((status) => {
    const circle = el("span", { class: "rp-count-circle tabular" }, [String(status.count)]);
    circle.style.background = KIND_COLORS[status.kind];
    let className = "rp-count";

    if (status.count === 0) {
      className = "rp-count is-zero";
    }

    return el("li", { class: className }, [circle, status.label]);
  });

  let eyebrowClass = "eyebrow";

  if (model.done) {
    eyebrowClass = "eyebrow rp-eyebrow-done";
  }

  side.appendChild(el("a", { class: "logo", href: "/" }, ["QuoteDesk"]));
  side.appendChild(
    el("div", { class: "rp-progress" }, [
      el("span", { class: eyebrowClass }, [model.eyebrow]),
      el("div", { class: "rp-progress-line" }, [
        el("span", { class: "tabular" }, [`${model.progress.finished} of ${model.progress.total} calls finished`]),
        el("span", { class: "tabular" }, [`${model.progress.pct}%`]),
      ]),
      el("div", { class: "rp-bar" }, [fill]),
    ]),
  );
  side.appendChild(el("ul", { class: "rp-counts" }, counts));
}

// ---------- Top bar ----------

/**
 * @param {HTMLElement} container
 * @param {import("./model.js").StayPill[]} pills
 */
function drawPills(container, pills) {
  for (const pill of pills) {
    const node = el("span", { class: "rp-pill", "data-kind": pill.kind }, [icon(/** @type {IconName} */ (pill.icon), 16), pill.text]);
    container.appendChild(node);
  }

  fitPills(container);
}

// Pills never wrap. When they don't fit, the asks pill goes first, then the rest from the end.
/**
 * @param {HTMLElement} container
 */
function fitPills(container) {
  const pills = /** @type {HTMLElement[]} */ ([...container.children]);

  for (const pill of pills) {
    pill.hidden = false;
  }

  const order = [...pills.filter((pill) => pill.dataset.kind === "asks"), ...pills.filter((pill) => pill.dataset.kind !== "asks").reverse()];

  for (const pill of order) {
    if (container.scrollWidth <= container.clientWidth) {
      return;
    }

    pill.hidden = true;
  }
}

async function stopCalls() {
  page.stopping = true;
  render();

  try {
    await fetch(`/api/runs/${encodeURIComponent(page.runId)}/stop`, { method: "POST" });
  } catch (error) {
    page.stopping = false;
    render();
  }
}

async function downloadSummary() {
  const response = await fetch(`/api/runs/${encodeURIComponent(page.runId)}/summary`);

  if (response.ok === false) {
    return;
  }

  const blob = new Blob([await response.text()], { type: "application/json" });
  const link = el("a", { href: URL.createObjectURL(blob), download: `quotedesk-${page.runId}.json` });
  link.click();
  URL.revokeObjectURL(link.href);
}

function selectActions() {
  return {
    phase: selectPhase(page.state),
    stopping: page.stopping,
  };
}

/**
 * @param {HTMLElement} container
 * @param {ReturnType<typeof selectActions>} model
 */
function drawActions(container, model) {
  if (model.phase === "done") {
    const download = el("button", { class: "btn btn-small", type: "button" }, [icon("download", 16), "Download"]);
    download.addEventListener("click", downloadSummary);
    container.appendChild(download);
    container.appendChild(el("a", { class: "btn btn-primary btn-small", href: "/new" }, ["New quote"]));
    return;
  }

  let label = "Stop calls";

  if (model.phase === "test") {
    label = "End call";
  }

  const stop = el("button", { class: "btn btn-small", type: "button", title: "The head agent decides now with the quotes it has" }, [
    icon("square", 14),
    label,
  ]);
  stop.disabled = model.stopping;
  stop.addEventListener("click", stopCalls);
  container.appendChild(stop);
}

// ---------- Intro ----------

function selectIntro() {
  const phase = selectPhase(page.state);
  const calls = selectCalls(page.state);
  const ranking = selectRanking(page.state);
  const winner = ranking[0];
  const nouns = businessNouns();
  const clock = formatClock(elapsedMs());

  if (phase === "test") {
    return {
      done: false,
      eyebrow: `Test call · ${clock}`,
      heading: "QuoteDesk is calling you",
      sub: "Answer as the front desk. The agent asks for a rate the way it would ask a hotel.",
    };
  }

  if (phase === "live") {
    return {
      done: false,
      eyebrow: `Live · ${clock}`,
      heading: `Calling ${countLabel(calls.length, nouns.singular, nouns.plural)}`,
      sub: "Every call runs at the same time, and the head agent ranks quotes as they come in.",
    };
  }

  const testRun = isSelfTestRun(page.state);

  if (winner === undefined) {
    return { done: true, eyebrow: `Done · ${clock}`, heading: "No quotes this time", sub: describeNoQuotes(page.state) };
  }

  if (testRun) {
    return { done: true, eyebrow: `Done · ${clock}`, heading: "Your quote is in", sub: `You quoted ${formatMoney(winner.total)}.` };
  }

  return {
    done: true,
    eyebrow: `Done · ${clock}`,
    heading: `${winner.name} is your best quote`,
    sub: `${countLabel(ranking.length, "quote", "quotes")} from ${countLabel(calls.length, nouns.singular, nouns.plural)} called.`,
  };
}

/**
 * @param {HTMLElement} container
 * @param {ReturnType<typeof selectIntro>} model
 */
function drawIntro(container, model) {
  let eyebrowClass = "eyebrow tabular";

  if (model.done) {
    eyebrowClass = "eyebrow tabular rp-eyebrow-done";
  }

  container.appendChild(el("span", { class: eyebrowClass }, [model.eyebrow]));
  container.appendChild(el("h1", {}, [model.heading]));
  container.appendChild(el("p", { class: "muted" }, [model.sub]));
}

// ---------- Head agent or winner ----------

function selectFeature() {
  if (page.state.finishedAt === null) {
    return { kind: "agent", agent: selectHeadAgent(page.state, now()) };
  }

  const winner = selectRanking(page.state)[0];

  if (winner === undefined) {
    return { kind: "none" };
  }

  const call = selectCalls(page.state).find((candidate) => candidate.callId === winner.callId);
  let phone = null;
  let breakfast = false;

  if (call !== undefined && call.listing !== null && isSelfTestCall(call) === false) {
    phone = call.listing.phone;
  }

  if (call !== undefined) {
    breakfast = readBreakfast(call.notes) === "included";
  }

  const nights = selectNights(page.state);
  let stayLine = "";

  if (nights > 0) {
    stayLine = countLabel(nights, "night", "nights");
  }

  if (nights > 0 && winner.fields.includesTaxes === true) {
    stayLine = `${stayLine}, taxes included`;
  }

  return {
    kind: "winner",
    name: winner.name,
    total: formatMoney(winner.total),
    stayLine,
    freeCancellation: winner.fields.freeCancellation === true,
    breakfast,
    phone,
  };
}

/**
 * @param {HTMLElement} container
 * @param {ReturnType<typeof selectFeature>} model
 */
function drawFeature(container, model) {
  if (model.kind === "agent" && model.agent !== undefined) {
    const agent = model.agent;
    let badge = el("span", { class: "rp-badge rp-badge-waiting" }, ["WAITING"]);

    if (agent.badge === "ranking") {
      badge = el("span", { class: "rp-badge rp-badge-ranking" }, ["RANKING LIVE"]);
    }

    container.appendChild(
      el("div", { class: "rp-card rp-agent" }, [
        el("div", { class: "rp-agent-head" }, [
          el("span", { class: "rp-tile-dark" }, [icon("gavel", 18)]),
          "Head agent",
          el("span", { class: "muted" }, ["· ranks by lowest total with taxes"]),
          badge,
        ]),
        el("p", { class: "rp-headline" }, [agent.headline]),
        el("p", { class: "muted" }, [agent.sub]),
        el("div", { class: "rp-agent-foot tabular" }, [el("span", {}, [agent.quoted]), el("span", {}, [agent.decides])]),
      ]),
    );
    return;
  }

  if (model.kind !== "winner") {
    return;
  }

  const pills = el("div", { class: "rp-winner-pills" });

  if (model.freeCancellation) {
    pills.appendChild(el("span", { class: "rp-pill-green" }, ["Free cancellation"]));
  }

  if (model.breakfast) {
    pills.appendChild(el("span", { class: "rp-pill-green" }, ["Breakfast included"]));
  }

  let book = null;

  if (typeof model.phone === "string") {
    book = el("div", { class: "rp-book" }, [
      el("a", { class: "btn btn-primary", href: `tel:${model.phone}` }, [icon("phone", 18), "Call to book"]),
      el("span", { class: "tabular" }, [formatPublicPhone(model.phone)]),
    ]);
  }

  container.appendChild(
    el("div", { class: "rp-card rp-winner" }, [
      el("span", { class: "rp-crown" }, [icon("crown", 26)]),
      el("div", {}, [
        el("span", { class: "muted" }, ["Winner · picked by the head agent"]),
        el("p", { class: "rp-winner-name" }, [String(model.name)]),
        el("p", { class: "rp-winner-total tabular" }, [String(model.total)]),
        el("span", { class: "muted" }, [String(model.stayLine)]),
        pills,
      ]),
      book,
    ]),
  );
}

// ---------- Test steps ----------

function selectSteps() {
  if (isSelfTestRun(page.state) === false) {
    return [];
  }

  return selectTestSteps(page.state);
}

/**
 * @param {HTMLElement} container
 * @param {ReturnType<typeof selectSteps>} steps
 */
function drawSteps(container, steps) {
  if (steps.length === 0) {
    return;
  }

  const items = steps.map((step, index) => {
    let marker = el("span", { class: "rp-step-marker tabular" }, [String(index + 1)]);

    if (step.phase === "done") {
      marker = el("span", { class: "rp-step-marker" }, [icon("check", 13)]);
    }

    return el("li", { class: `rp-step rp-step-${step.phase}` }, [marker, step.text]);
  });

  container.appendChild(el("ol", { class: "rp-steps" }, items));
}

// ---------- Top 3 and runners-up ----------

function selectQuotes() {
  const done = page.state.finishedAt !== null;
  let quotes = selectTopThree(page.state);
  let title = "Top 3 so far";

  if (done) {
    quotes = selectRunnersUp(page.state);
    title = "Runners-up";
  }

  return {
    done,
    title,
    quotes: quotes.map((quote) => ({
      callId: quote.callId,
      rank: quote.rank,
      name: quote.name,
      total: formatMoney(quote.total),
      terms: describeTerms(quote.fields),
    })),
  };
}

/**
 * @param {HTMLElement} container
 * @param {ReturnType<typeof selectQuotes>} model
 */
function drawQuotes(container, model) {
  if (model.quotes.length === 0) {
    return;
  }

  const cards = model.quotes.map((quote) => {
    const leading = model.done === false && quote.rank === 1;
    let className = "rp-quote";
    let tag = null;

    if (leading) {
      className = "rp-quote is-leader";
      tag = el("span", { class: "rp-leading" }, ["Leading"]);
    }

    const card = el("button", { class: className, type: "button" }, [
      el("div", { class: "rp-quote-top" }, [el("span", {}, [`#${quote.rank}`]), tag]),
      el("span", { class: "rp-quote-name" }, [quote.name]),
      el("span", { class: "rp-quote-total tabular" }, [quote.total]),
      el("span", { class: "rp-quote-terms" }, [quote.terms]),
    ]);
    card.addEventListener("click", () => pickCall(quote.callId));
    return card;
  });

  container.appendChild(el("p", { class: "rp-section-title" }, [model.title]));
  container.appendChild(el("div", { class: "rp-three" }, cards));
}

// ---------- Grid ----------

/**
 * The grid builds its frame once, then only repaints the tiles whose look changed.
 * @param {HTMLElement} card
 */
function createGrid(card) {
  const title = el("p", { class: "rp-section-title" });
  const legend = el("div", { class: "rp-legend" });
  const tiles = el("div", { class: "rp-tiles" });
  /** @type {Map<string, { button: HTMLButtonElement, key: string }>} */
  const nodes = new Map();
  let lastLegend = "";
  let lastOrder = "";

  card.appendChild(el("div", { class: "rp-grid-head" }, [title, legend]));
  card.appendChild(tiles);

  /**
   * @param {HTMLButtonElement} button
   * @param {TileModel} tile
   * @param {import("./model.js").TileSize} size
   */
  function paint(button, tile, size) {
    let className = `rp-tile rp-tile-${tile.kind}`;

    if (tile.selected) {
      className += " is-selected";
    }

    button.className = className;
    button.title = `${tile.name} · ${KIND_LABELS[tile.kind]}`;
    button.setAttribute("aria-label", button.title);
    button.style.background = "";
    button.style.color = "";

    if (tile.color !== null && tile.textColor !== null) {
      button.style.background = tile.color;
      button.style.color = tile.textColor;
    }

    clear(button);

    if (size === "named") {
      let status = KIND_LABELS[tile.kind];

      if (tile.price !== null) {
        status = `$${tile.price}`;
      }

      button.appendChild(el("span", { class: "rp-tile-name" }, [tile.name]));
      button.appendChild(el("span", { class: "rp-tile-status tabular" }, [status]));
      return;
    }

    if (tile.price !== null) {
      button.appendChild(el("span", { class: "tabular" }, [tile.price]));
    }
  }

  function update() {
    const calls = selectCalls(page.state);
    const size = selectTileSize(calls.length);
    const best = selectBest(page.state);
    const selected = findSelectedCall();
    let selectedId = null;

    if (selected !== null) {
      selectedId = selected.callId;
    }
    const counts = selectStatusCounts(page.state).filter((status) => status.count > 0);
    let heading = `All ${calls.length} calls`;

    if (page.state.finishedAt !== null) {
      heading = "Where every call landed";
    }

    title.textContent = heading;
    tiles.className = `rp-tiles rp-tiles-${size}`;

    const legendKey = JSON.stringify(counts);

    if (legendKey !== lastLegend) {
      lastLegend = legendKey;
      clear(legend);
      legend.appendChild(el("span", {}, ["Cheaper", el("span", { class: "rp-scale" }), "Pricier"]));

      for (const status of counts) {
        const swatch = el("span", { class: "rp-swatch" });
        swatch.style.background = KIND_COLORS[status.kind];
        legend.appendChild(el("span", {}, [swatch, `${status.label} ${status.count}`]));
      }
    }

    for (const call of calls) {
      const tile = buildTile(call, best, selectedId);
      const key = `${size}|${JSON.stringify(tile)}`;
      let node = nodes.get(call.callId);

      if (node === undefined) {
        const button = el("button", { type: "button" });
        button.addEventListener("click", () => pickCall(call.callId));
        node = { button, key: "" };
        nodes.set(call.callId, node);
      }

      if (node.key !== key) {
        node.key = key;
        paint(node.button, tile, size);
      }
    }

    const order = calls.map((call) => call.callId).join(",");

    if (order !== lastOrder) {
      lastOrder = order;
      clear(tiles);

      for (const call of calls) {
        const node = nodes.get(call.callId);

        if (node !== undefined) {
          tiles.appendChild(node.button);
        }
      }
    }
  }

  return update;
}

// ---------- Right panel ----------

/**
 * @param {CallState} call
 * @returns {string}
 */
function speakerName(call) {
  if (isSelfTestCall(call)) {
    return "You";
  }

  if (page.state.provider === "live") {
    return "Front desk";
  }

  return call.name;
}

/**
 * @param {"agent" | "business"} speaker
 * @param {CallState} call
 * @returns {string}
 */
function turnName(speaker, call) {
  if (speaker === "agent") {
    return "AI caller";
  }

  return speakerName(call);
}

/**
 * @param {CallState} call
 * @returns {string | null}
 */
function describeQuoteTerms(call) {
  if (call.quote === null) {
    return null;
  }

  return describeTerms(call.quote.fields);
}

function selectPanel() {
  const call = findSelectedCall();
  const done = page.state.finishedAt !== null;

  if (call === null) {
    return { done, call: null };
  }

  const kind = classifyCall(call);
  let audioUrl = null;

  if (page.state.provider === "live" && call.status === "ended") {
    audioUrl = `/api/runs/${encodeURIComponent(page.runId)}/calls/${encodeURIComponent(call.callId)}/audio`;
  }

  let listeningTo = call.name;

  if (isSelfTestCall(call)) {
    listeningTo = "You";
  }

  return {
    done,
    stats: selectDoneStats(page.state),
    transcriptOpen: page.transcriptOpen,
    call: {
      name: call.name,
      listeningTo,
      kind,
      status: KIND_LABELS[kind],
      typing: kind === "talking" && page.state.provider !== "live",
      turns: call.turns.map((turn) => ({
        speaker: turn.speaker,
        name: turnName(turn.speaker, call),
        text: turn.text,
      })),
      tiles: describeQuoteTiles(call),
      terms: describeQuoteTerms(call),
      audioUrl,
      brief: call.brief,
    },
  };
}

/**
 * @param {ReturnType<typeof selectPanel>["call"]} call
 * @returns {HTMLElement}
 */
function renderTranscript(call) {
  const list = el("ol", { class: "rp-transcript" });

  if (call === null) {
    return list;
  }

  for (const turn of call.turns) {
    list.appendChild(el("li", { class: `rp-turn rp-turn-${turn.speaker}` }, [el("strong", {}, [turn.name]), turn.text]));
  }

  if (call.turns.length === 0 && call.kind === "talking" && page.state.provider === "live") {
    list.appendChild(el("li", { class: "rp-typing" }, ["On the call. The transcript arrives when it ends."]));
  }

  if (call.typing) {
    list.appendChild(el("li", { class: "rp-typing" }, ["…"]));
  }

  return list;
}

/**
 * @param {{ total: string, cancel: string, breakfast: string }} tiles
 * @returns {HTMLElement}
 */
function renderMiniTiles(tiles) {
  return el("div", { class: "rp-mini-tiles" }, [
    el("div", { class: "rp-mini" }, [el("span", {}, ["Total"]), el("span", { class: "tabular" }, [tiles.total])]),
    el("div", { class: "rp-mini" }, [el("span", {}, ["Cancel"]), el("span", {}, [tiles.cancel])]),
    el("div", { class: "rp-mini" }, [el("span", {}, ["Breakfast"]), el("span", {}, [tiles.breakfast])]),
  ]);
}

/**
 * Only the five allowed variables are shown, so a phone number can never appear here.
 * @param {Record<string, string> | null} brief
 * @returns {HTMLElement | null}
 */
function renderBrief(brief) {
  if (brief === null) {
    return null;
  }

  const list = el("dl", {});

  for (const [key, label] of Object.entries(BRIEF_LABELS)) {
    const value = brief[key];

    if (value !== undefined) {
      list.appendChild(el("dt", {}, [label]));
      list.appendChild(el("dd", {}, [value]));
    }
  }

  return el("details", { class: "rp-brief" }, [el("summary", {}, ["Sent to the agent"]), list]);
}

/**
 * @param {HTMLElement} container
 * @param {ReturnType<typeof selectPanel>} model
 */
function drawPanel(container, model) {
  const call = model.call;

  if (model.done && model.stats !== undefined) {
    const stats = model.stats.map((stat) =>
      el("div", { class: "rp-mini" }, [el("span", {}, [stat.label]), el("span", { class: "tabular" }, [stat.value])]),
    );
    container.appendChild(el("div", { class: "rp-card" }, [el("p", { class: "rp-section-title" }, ["How it went"]), el("div", { class: "rp-stats" }, stats)]));
  }

  if (call === null || call === undefined) {
    return;
  }

  const status = el("span", { class: `rp-status rp-status-${call.kind}` }, [call.status]);

  if (model.done === false) {
    container.appendChild(
      el("div", { class: "rp-card" }, [
        el("div", { class: "rp-panel-head" }, [el("strong", {}, [`Listening to ${call.listeningTo}`]), status]),
        renderTranscript(call),
        renderMiniTiles(call.tiles),
      ]),
    );
    return;
  }

  /** @type {HTMLElement[]} */
  const summary = [el("div", { class: "rp-panel-head" }, [el("strong", {}, [call.name]), status])];

  if (call.terms !== null) {
    summary.push(el("p", { class: "muted" }, [`${call.tiles.total} · ${call.terms}`]));
  }

  if (call.audioUrl !== null) {
    summary.push(el("audio", { controls: true, preload: "none", src: call.audioUrl }));
  }

  const read = el("details", { class: "rp-read" }, [el("summary", {}, ["Read transcript"]), renderTranscript(call)]);
  /** @type {HTMLDetailsElement} */ (read).open = model.transcriptOpen;
  read.addEventListener("toggle", () => {
    page.transcriptOpen = /** @type {HTMLDetailsElement} */ (read).open;
  });
  summary.push(read);

  const brief = renderBrief(call.brief);

  if (brief !== null) {
    summary.push(brief);
  }

  container.appendChild(el("div", { class: "rp-card rp-selected" }, summary));
}

// ---------- Page ----------

/** @type {(() => void)[]} */
let regions = [];

function render() {
  for (const update of regions) {
    update();
  }
}

/**
 * @param {RunState} state
 * @param {boolean} ended
 */
function receiveState(state, ended) {
  page.state = state;
  page.ended = ended;

  if (state.lastEventAt !== null) {
    const offset = Date.now() - state.lastEventAt;

    if (offset < page.clockOffsetMs) {
      page.clockOffsetMs = offset;
    }
  }

  render();
}

function main() {
  const match = RUN_PATH.exec(window.location.pathname);

  if (match === null || match[1] === undefined) {
    findElement("intro").appendChild(el("h1", {}, ["This run doesn't exist."]));
    return;
  }

  page.runId = match[1];
  const pills = findElement("pills");

  regions = [
    region(findElement("side"), selectSide, drawSide),
    region(pills, () => selectStayPills(page.state), drawPills),
    region(findElement("actions"), selectActions, drawActions),
    region(findElement("intro"), selectIntro, drawIntro),
    region(findElement("feature"), selectFeature, drawFeature),
    region(findElement("steps"), selectSteps, drawSteps),
    region(findElement("quotes"), selectQuotes, drawQuotes),
    createGrid(findElement("grid")),
    region(findElement("panel"), selectPanel, drawPanel),
  ];

  window.addEventListener("resize", () => fitPills(pills));
  window.setInterval(render, TICK_MS);
  followRun(page.runId, receiveState);
}

main();
