// @ts-check
import { clear, el, icon } from "../dom.js";
import { formatPublicPhone, normalizeNorthAmericanNumber } from "../phone.js";
import { BEDS, buildHotelSearch, countNights, MAX_GUESTS, MIN_GUESTS } from "../stay.js";
import { listCallableHotels, pickTop } from "./hotelList.js";
import {
  buildStayPayload,
  createWizardState,
  describeAgentAsks,
  isStepValid,
  STEPS,
  summarizeStay,
  todayIso,
  validateDates,
} from "./wizardState.js";

/**
 * @typedef {import("./hotelList.js").PlaceHotel} PlaceHotel
 * @typedef {{ text: string, main: string, secondary: string }} AreaSuggestion
 */

const AUTOCOMPLETE_DELAY_MS = 300;
const DEFAULT_MAX_CALLS = 6;
const SAMPLE_NOTICE = "Google Places not set up, showing sample hotels.";

const today = todayIso(new Date());
// The whole quote lives in this one object, in memory only. Nothing is stored or put in the URL.
const state = createWizardState();
let maxCalls = DEFAULT_MAX_CALLS;
let selfTestAvailable = false;

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

const sideSteps = findElement("side-steps");
const sideSummary = findElement("side-summary");
const stepBody = findElement("step");
const backButton = /** @type {HTMLButtonElement} */ (findElement("back"));
const closeLink = findElement("close");
const continueButton = /** @type {HTMLButtonElement} */ (findElement("continue"));
const confirmLayer = findElement("confirm");

/**
 * @param {string} url
 * @param {unknown} body
 * @returns {Promise<{ ok: boolean, body: Record<string, unknown> }>}
 */
async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { ok: response.ok, body: await response.json() };
}

/**
 * @param {Record<string, unknown>} body
 * @param {string} fallback
 * @returns {string}
 */
function readError(body, fallback) {
  if (typeof body.error === "string") {
    return body.error;
  }

  return fallback;
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

// ---------- Sidebar and footer ----------

/**
 * @param {number} index
 * @returns {"done" | "current" | "upcoming"}
 */
function stepPhase(index) {
  if (index === state.step) {
    return "current";
  }

  if (index < state.reached) {
    return "done";
  }

  return "upcoming";
}

function renderSidebar() {
  clear(sideSteps);

  STEPS.forEach((step, index) => {
    const phase = stepPhase(index);
    let marker = el("span", { class: "side-circle tabular" }, [String(index + 1)]);

    if (phase === "done") {
      marker = el("span", { class: "side-circle" }, [icon("check", 18)]);
    }

    const button = el("button", { class: `side-step side-step-${phase}`, type: "button" }, [marker, step.title]);
    button.disabled = phase !== "done";
    button.addEventListener("click", () => goToStep(index));
    sideSteps.appendChild(el("li", {}, [button]));
  });

  clear(sideSummary);
  sideSummary.appendChild(el("span", { class: "side-summary-title" }, ["Your stay"]));
  const lines = summarizeStay(state);

  if (lines.length === 0) {
    sideSummary.appendChild(el("span", { class: "side-empty" }, ["Fills in as you go."]));
  }

  for (const line of lines) {
    sideSummary.appendChild(el("div", { class: "side-line" }, [el("span", {}, [line.label]), el("span", {}, [line.value])]));
  }
}

function renderFooter() {
  let label = "Continue";

  if (state.step === STEPS.length - 1) {
    label = `Call ${countLabel(state.picked.length, "hotel", "hotels")}`;
  }

  continueButton.textContent = label;
  continueButton.disabled = isStepValid(state, state.step, today) === false;
}

// Typing updates the sidebar and footer only, so the field being typed in is never rebuilt.
function refresh() {
  renderSidebar();
  renderFooter();
}

// ---------- Navigation ----------

/**
 * @param {number} index
 */
function goToStep(index) {
  state.step = index;
  state.reached = Math.max(state.reached, index);
  renderStep();
}

function goForward() {
  if (isStepValid(state, state.step, today) === false) {
    return;
  }

  if (state.step === STEPS.length - 1) {
    openConfirm();
    return;
  }

  goToStep(state.step + 1);
}

function goBack() {
  if (state.step === 0) {
    window.location.assign("/");
    return;
  }

  goToStep(state.step - 1);
}

// ---------- Shared pieces ----------

/**
 * @param {string} label
 * @param {HTMLElement} control
 * @returns {HTMLElement}
 */
function field(label, control) {
  return el("label", { class: "field" }, [el("span", { class: "field-label" }, [label]), control]);
}

/**
 * @param {string} label
 * @param {boolean} on
 * @param {() => void} onClick
 * @returns {HTMLButtonElement}
 */
function chip(label, on, onClick) {
  let className = "chip";

  if (on) {
    className = "chip is-on";
  }

  const button = el("button", { class: className, type: "button", "aria-pressed": String(on) }, [label]);
  button.addEventListener("click", onClick);
  return button;
}

/**
 * @param {string[]} list
 * @param {string} key
 * @returns {string[]}
 */
function toggleIn(list, key) {
  if (list.includes(key)) {
    return list.filter((item) => item !== key);
  }

  return [...list, key];
}

// ---------- Step 1: where ----------

/**
 * Suggestions come from Google Places autocomplete through the server, which caches and limits them.
 * @param {HTMLInputElement} input
 * @param {(text: string) => void} onPick
 * @returns {HTMLElement}
 */
function withSuggestions(input, onPick) {
  const list = el("ul", { class: "suggest-list", role: "listbox" });
  /** @type {number | undefined} */
  let timer = undefined;
  let latest = "";

  list.hidden = true;

  /** @param {AreaSuggestion[]} suggestions */
  function show(suggestions) {
    clear(list);
    list.hidden = suggestions.length === 0;

    for (const suggestion of suggestions) {
      const option = el("button", { class: "suggest-item", type: "button", role: "option" }, [
        el("span", {}, [suggestion.main]),
        el("span", {}, [suggestion.secondary]),
      ]);
      // Picking happens on mousedown, before the input's blur hides the list.
      option.addEventListener("mousedown", (event) => {
        event.preventDefault();
        input.value = suggestion.text;
        onPick(suggestion.text);
        list.hidden = true;
      });
      list.appendChild(el("li", {}, [option]));
    }
  }

  async function lookUp() {
    const typed = input.value;
    latest = typed;

    try {
      const result = await postJson("/api/places/autocomplete", { input: typed });

      if (latest === typed && result.ok && Array.isArray(result.body.suggestions)) {
        show(/** @type {AreaSuggestion[]} */ (result.body.suggestions));
      }
    } catch (error) {
      show([]);
    }
  }

  input.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(lookUp, AUTOCOMPLETE_DELAY_MS);
  });
  input.addEventListener("blur", () => {
    list.hidden = true;
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      list.hidden = true;
    }
  });

  return el("div", { class: "suggest" }, [input, list]);
}

/** @returns {HTMLElement} */
function renderWhereStep() {
  const area = el("input", {
    class: "input",
    type: "text",
    autocomplete: "off",
    placeholder: "Downtown Toronto",
    value: state.area,
    "aria-label": "City or area",
  });

  /** @param {string} text */
  function setArea(text) {
    state.area = text;
    refresh();
  }

  area.addEventListener("input", () => setArea(area.value));

  return el("div", { class: "wizard-stack" }, [
    el("div", { class: "field" }, [el("span", { class: "field-label" }, ["City or area"]), withSuggestions(area, setArea)]),
  ]);
}

// ---------- Step 2: when and who ----------

/** @returns {HTMLElement} */
function renderDates() {
  const checkIn = el("input", { class: "input", type: "date", min: today, value: state.checkIn, "aria-label": "Check-in" });
  const checkOut = el("input", { class: "input", type: "date", min: today, value: state.checkOut, "aria-label": "Check-out" });
  const nights = el("span", { class: "pill tabular" });
  const errorText = el("p", { class: "error-text", role: "alert" });

  function update() {
    state.checkIn = checkIn.value;
    state.checkOut = checkOut.value;

    if (state.checkIn !== "") {
      checkOut.min = state.checkIn;
    }

    const error = validateDates(state.checkIn, state.checkOut, today);
    const complete = state.checkIn !== "" && state.checkOut !== "";
    errorText.textContent = "";
    nights.hidden = complete === false || error !== null;

    if (error !== null) {
      errorText.textContent = error;
    }

    if (nights.hidden === false) {
      nights.textContent = countLabel(countNights(state.checkIn, state.checkOut), "night", "nights");
    }

    refresh();
  }

  checkIn.addEventListener("change", update);
  checkOut.addEventListener("change", update);
  update();

  return el("div", { class: "wizard-stack" }, [
    el("div", { class: "field-row" }, [field("Check-in", checkIn), field("Check-out", checkOut)]),
    el("div", {}, [nights]),
    errorText,
  ]);
}

/** @returns {HTMLElement} */
function renderGuests() {
  const minus = el("button", { class: "stepper-button", type: "button", "aria-label": "Fewer guests" }, [icon("minus", 18)]);
  const plus = el("button", { class: "stepper-button", type: "button", "aria-label": "More guests" }, [icon("plus", 18)]);
  const shown = el("span", { class: "stepper-value tabular", "aria-live": "polite" });

  function paint() {
    shown.textContent = String(state.guests);
    minus.disabled = state.guests <= MIN_GUESTS;
    plus.disabled = state.guests >= MAX_GUESTS;
  }

  /** @param {number} change */
  function move(change) {
    state.guests = Math.min(MAX_GUESTS, Math.max(MIN_GUESTS, state.guests + change));
    paint();
    refresh();
  }

  minus.addEventListener("click", () => move(-1));
  plus.addEventListener("click", () => move(1));
  paint();

  return el("div", { class: "card stepper-card" }, [
    el("div", { class: "stepper-row" }, [
      el("div", { class: "stepper-label" }, [el("strong", {}, ["Guests"]), el("span", { class: "muted" }, ["In one room"])]),
      el("div", { class: "stepper" }, [minus, shown, plus]),
    ]),
  ]);
}

/** @returns {HTMLElement} */
function renderBeds() {
  const beds = el("div", { class: "chips" });

  function paint() {
    clear(beds);

    for (const bed of BEDS) {
      beds.appendChild(
        chip(bed.label, state.bed === bed.key, () => {
          state.bed = bed.key;
          paint();
          refresh();
        }),
      );
    }
  }

  paint();
  return el("div", { class: "chip-group" }, [el("span", { class: "field-label" }, ["Bed"]), beds]);
}

/** @returns {HTMLElement} */
function renderWhenStep() {
  return el("div", { class: "wizard-stack" }, [renderDates(), renderGuests(), renderBeds()]);
}

// ---------- Step 3: pick hotels ----------

/**
 * @param {PlaceHotel} hotel
 * @returns {string | null}
 */
function describeRating(hotel) {
  if (hotel.rating === null) {
    return null;
  }

  if (hotel.reviewCount === null) {
    return hotel.rating.toFixed(1);
  }

  return `${hotel.rating.toFixed(1)} (${hotel.reviewCount.toLocaleString("en-US")} reviews)`;
}

/**
 * @param {PlaceHotel} hotel
 * @param {() => void} onChange
 * @returns {HTMLElement}
 */
function hotelRow(hotel, onChange) {
  const picked = state.picked.includes(hotel.placeId);
  const box = el("input", { type: "checkbox", "aria-label": `Pick ${hotel.name}` });
  const details = [el("span", { class: "tabular" }, [icon("phone", 14), formatPublicPhone(hotel.phone)])];
  const rating = describeRating(hotel);

  box.checked = picked;
  box.disabled = picked === false && state.picked.length >= maxCalls;
  box.addEventListener("change", () => {
    state.picked = toggleIn(state.picked, hotel.placeId);
    onChange();
  });

  if (rating !== null) {
    details.push(el("span", {}, [icon("star", 14), rating]));
  }

  if (hotel.priceLevel !== null) {
    details.push(el("span", {}, [hotel.priceLevel]));
  }

  return el("li", {}, [
    el("label", { class: "hotel-row" }, [
      box,
      el("div", { class: "hotel-info" }, [
        el("span", { class: "hotel-name" }, [hotel.name]),
        el("span", { class: "hotel-line" }, [el("span", {}, [icon("map-pin", 14), hotel.address])]),
        el("span", { class: "hotel-line" }, details),
      ]),
    ]),
  ]);
}

/** @returns {HTMLElement} */
function renderHotelsStep() {
  const container = el("div", {});
  const status = el("p", { class: "notice" });
  const query = buildHotelSearch(state.area);

  function paint() {
    clear(container);

    if (state.hotels.length === 0) {
      return;
    }

    const shown = listCallableHotels(state.hotels);
    const pickTopButton = el("button", { class: "btn btn-small", type: "button" }, [`Pick top ${maxCalls}`]);
    const list = el("ul", { class: "hotel-list" });

    pickTopButton.addEventListener("click", () => {
      state.picked = pickTop(shown, maxCalls);
      paint();
      refresh();
    });

    for (const hotel of shown) {
      list.appendChild(
        hotelRow(hotel, () => {
          paint();
          refresh();
        }),
      );
    }

    if (shown.length === 0) {
      list.appendChild(el("li", { class: "hotel-empty" }, ["Only call centers came up here. Try a different area."]));
    }

    container.appendChild(
      el("div", { class: "hotel-meta" }, [
        el("span", { class: "tabular" }, [`${countLabel(shown.length, "hotel", "hotels")}, best rated first`]),
        el("span", { class: "tabular" }, [`${state.picked.length} of ${maxCalls} picked`]),
        pickTopButton,
      ]),
    );
    container.appendChild(el("div", { class: "card hotel-card" }, [list]));
  }

  function showStatus() {
    status.textContent = "";

    if (state.sample) {
      status.textContent = SAMPLE_NOTICE;
    }

    if (state.hotels.length === 0 && state.searchedFor !== "") {
      status.textContent = "No hotels with a phone number came up. Try a different area.";
    }
  }

  async function search() {
    status.textContent = "Finding hotels...";

    try {
      const result = await postJson("/api/places/search", { query });

      if (result.ok === false) {
        status.textContent = readError(result.body, "The hotel search failed.");
        return;
      }

      state.hotels = /** @type {PlaceHotel[]} */ (result.body.hotels);
      state.sample = result.body.sample === true;
      state.searchedFor = query;
      // Picks from an earlier search may not be in this one.
      const ids = new Set(state.hotels.map((hotel) => hotel.placeId));
      state.picked = state.picked.filter((id) => ids.has(id));
      showStatus();
      paint();
      refresh();
    } catch (error) {
      status.textContent = "Could not reach the server.";
    }
  }

  if (state.searchedFor === query) {
    showStatus();
    paint();
  } else {
    search();
  }

  return el("div", {}, [el("p", { class: "muted search-for" }, [`Searching for “${query}”.`]), status, container]);
}

// ---------- Confirm and start ----------

function closeConfirm() {
  clear(confirmLayer);
  confirmLayer.hidden = true;
}

async function startCalls() {
  const stay = buildStayPayload(state);
  const result = await postJson("/api/runs", { provider: "live", stay, placeIds: state.picked });

  if (result.ok === false) {
    return readError(result.body, "Could not start the calls.");
  }

  window.location.assign(`/run/${encodeURIComponent(String(result.body.runId))}`);
  return null;
}

function openConfirm() {
  const hotels = countLabel(state.picked.length, "hotel", "hotels");
  const asks = describeAgentAsks(buildStayPayload(state)).map((line) =>
    el("li", {}, [el("span", {}, [line.label]), el("span", {}, [line.value])]),
  );
  const start = el("button", { class: "btn btn-primary", type: "button" }, ["Start calls"]);
  const cancel = el("button", { class: "btn", type: "button" }, ["Cancel"]);
  const errorText = el("p", { class: "error-text", role: "alert" });

  start.addEventListener("click", async () => {
    start.disabled = true;
    const error = await startCalls();

    if (error !== null) {
      errorText.textContent = error;
      start.disabled = false;
    }
  });
  cancel.addEventListener("click", closeConfirm);

  clear(confirmLayer);
  confirmLayer.appendChild(
    el("div", { class: "card modal", role: "dialog", "aria-modal": "true", "aria-label": `Call ${hotels} now?` }, [
      el("h2", {}, [`Call ${hotels} now?`]),
      el("p", { class: "muted" }, ["The agent will ask each hotel for:"]),
      el("ul", { class: "modal-asks" }, asks),
      el("p", { class: "modal-note" }, ["Calls are recorded. Nothing is booked until you call the hotel yourself."]),
      errorText,
      el("div", { class: "modal-actions" }, [cancel, start]),
      createCallMeInstead(),
    ]),
  );
  confirmLayer.hidden = false;
  start.focus();
}

/** @type {{ key: "live" | "test", label: string, hint: string }[]} */
const TEST_SCRIPTS = [
  { key: "live", label: "Real call script", hint: "The agent talks exactly as it would to a hotel." },
  { key: "test", label: "Tutorial", hint: "The guided version: the agent explains QuoteDesk first." },
];

/**
 * One call to the user's own phone with this exact stay, instead of the picked hotels.
 * The number lives in this input and the one request that starts the call, nowhere else.
 * @param {string} testNumber
 * @param {"live" | "test"} testCallMode
 * @returns {Promise<string | null>}
 */
async function startTestCall(testNumber, testCallMode) {
  const stay = buildStayPayload(state);
  const result = await postJson("/api/runs", { provider: "live", stay, testNumber, testCallMode });

  if (result.ok === false) {
    return readError(result.body, "Could not start the test call.");
  }

  window.location.assign(`/run/${encodeURIComponent(String(result.body.runId))}`);
  return null;
}

/** @returns {HTMLElement | null} */
function createCallMeInstead() {
  if (selfTestAvailable === false) {
    return null;
  }

  const open = el("button", { class: "btn-link", type: "button" }, ["Call me instead"]);
  const input = el("input", {
    class: "input",
    type: "tel",
    name: "call-me-to-test",
    autocomplete: "off",
    placeholder: "+1 your number",
    "aria-label": "Your phone number for one test call",
  });
  const scripts = el("div", { class: "chips" });
  const hint = el("p", { class: "field-hint" });
  const callMe = el("button", { class: "btn btn-primary", type: "button" }, ["Call me"]);
  const errorText = el("p", { class: "error-text", role: "alert" });
  const panel = el("div", { class: "instead" }, [
    el("span", { class: "field-label" }, ["Test this quote on your own phone"]),
    input,
    scripts,
    hint,
    el("p", { class: "field-hint" }, ["Used for this one call. Never saved. The picked hotels aren't called."]),
    errorText,
    el("div", { class: "modal-actions" }, [callMe]),
  ]);
  /** @type {"live" | "test"} */
  let script = "live";

  function paintScripts() {
    clear(scripts);

    for (const option of TEST_SCRIPTS) {
      scripts.appendChild(
        chip(option.label, script === option.key, () => {
          script = option.key;
          paintScripts();
        }),
      );

      if (script === option.key) {
        hint.textContent = option.hint;
      }
    }
  }

  async function call() {
    errorText.textContent = "";
    const number = normalizeNorthAmericanNumber(input.value);

    if (number === null) {
      errorText.textContent = "Enter a North American number: 10 digits, with or without +1.";
      return;
    }

    callMe.disabled = true;
    const error = await startTestCall(number, script);
    callMe.disabled = false;

    if (error !== null) {
      errorText.textContent = error;
      return;
    }

    // The call has started, so the number has nothing left to do in the page.
    input.value = "";
  }

  panel.hidden = true;
  paintScripts();
  open.addEventListener("click", () => {
    panel.hidden = false;
    open.hidden = true;
    input.focus();
  });
  callMe.addEventListener("click", call);

  return el("div", { class: "instead-wrap" }, [open, panel]);
}

// ---------- Rendering ----------

const STEP_RENDERERS = [renderWhereStep, renderWhenStep, renderHotelsStep];

function renderStep() {
  const step = STEPS[state.step];
  const render = STEP_RENDERERS[state.step];

  if (step === undefined || render === undefined) {
    return;
  }

  clear(stepBody);
  stepBody.appendChild(
    el("div", { class: "wizard-heading" }, [
      el("span", { class: "eyebrow tabular" }, [`Step ${state.step + 1} of ${STEPS.length}`]),
      el("h1", {}, [step.question]),
      el("p", { class: "muted" }, [step.hint]),
    ]),
  );
  stepBody.appendChild(render());
  refresh();
  window.scrollTo(0, 0);
}

async function loadLimits() {
  try {
    const response = await fetch("/api/jobs");
    const body = await response.json();

    if (Number(body.liveMaxCalls) > 0) {
      maxCalls = Number(body.liveMaxCalls);
    }

    selfTestAvailable = body.selfTest === true;
  } catch (error) {
    maxCalls = DEFAULT_MAX_CALLS;
  }
}

function main() {
  backButton.prepend(icon("arrow-left", 18));
  closeLink.appendChild(icon("x", 20));
  backButton.addEventListener("click", goBack);
  continueButton.addEventListener("click", goForward);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && confirmLayer.hidden === false) {
      closeConfirm();
    }
  });
  loadLimits().then(renderStep);
}

main();
